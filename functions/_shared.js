// Shared by the vote endpoints. These run as Cloudflare Pages Functions, on the same origin as
// the site itself — which is why there is no CORS handling here and no second deployment to keep
// in step with the first.

/** Non-reversible voter id. The salt is a project secret, so hashes cannot be precomputed. */
export async function voterId(request, env) {
	const ip = request.headers.get('cf-connecting-ip') ?? '0.0.0.0'
	const data = new TextEncoder().encode(`${ip}:${env.VOTE_SALT ?? 'unsalted'}`)
	const digest = await crypto.subtle.digest('SHA-256', data)
	return [...new Uint8Array(digest)]
		.slice(0, 16)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}

export const PACK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i
// A preset's stable community id and a comment id: ps_/cm_ + 26 lowercase Crockford base32 chars.
export const PRESET_ID = /^ps_[0-9a-z]{26}$/
export const COMMENT_ID = /^cm_[0-9a-z]{26}$/

export const json = (body, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json',
			// The desktop app fetches this from its own local origin.
			'access-control-allow-origin': '*',
		},
	})

// ---- ids -------------------------------------------------------------------------------------
const CB32 = '0123456789abcdefghjkmnpqrstvwxyz'
function enc32(num, len) {
	let s = ''
	for (let i = len - 1; i >= 0; i--) {
		s = CB32[Number(num % 32n)] + s
		num /= 32n
	}
	return s
}
/** A ULID (48-bit ms time + 80-bit random), lowercased, with an optional prefix — time-sortable, collision-proof. */
export function ulid(prefix = '') {
	const t = enc32(BigInt(Date.now()), 10)
	const bytes = crypto.getRandomValues(new Uint8Array(10))
	let r = 0n
	for (const b of bytes) r = (r << 8n) | BigInt(b)
	return prefix + t + enc32(r, 16)
}

// ---- catalogue -------------------------------------------------------------------------------
/**
 * The flat preset catalogue (site/presets.json) — the static index CI builds from the pack files.
 * Fetched same-origin so a Function reads exactly what the CDN is serving; edge-cached, so this is
 * cheap. Returns the parsed catalogue plus a Map for id lookups.
 */
export async function loadCatalogue(request) {
	const url = new URL('/presets.json', request.url)
	const res = await fetch(url, { cf: { cacheTtl: 60, cacheEverything: true } })
	if (!res.ok) throw new Error(`catalogue unavailable (${res.status})`)
	const cat = await res.json()
	const byId = new Map()
	for (const p of cat.presets ?? []) byId.set(p.id, p)
	return { ...cat, byId }
}

// ---- scoring + stats -------------------------------------------------------------------------
/** Bayesian-adjusted rating so a single 5-star doesn't outrank a well-loved chain with a few 4s. */
export const bayes = (sum, count, m = 4.0, C = 5) => (C * m + (sum || 0)) / (C + (count || 0))

/**
 * Every preset's engagement in three small aggregate queries, merged by id. Idempotent-by-key
 * tables mean these counts cannot be inflated past one-per-person.
 */
export async function presetStats(env) {
	const [inst, rat, hrt] = await Promise.all([
		env.DB.prepare('SELECT preset_id, COUNT(*) AS n FROM installs GROUP BY preset_id').all(),
		env.DB.prepare('SELECT preset_id, COUNT(*) AS n, SUM(stars) AS s FROM ratings GROUP BY preset_id').all(),
		env.DB.prepare('SELECT preset_id, COUNT(*) AS n FROM hearts GROUP BY preset_id').all(),
	])
	const map = {}
	const get = (id) => (map[id] ??= { installs: 0, ratings: 0, ratingSum: 0, hearts: 0 })
	for (const r of inst.results ?? []) get(r.preset_id).installs = r.n
	for (const r of rat.results ?? []) {
		const m = get(r.preset_id)
		m.ratings = r.n
		m.ratingSum = r.s ?? 0
	}
	for (const r of hrt.results ?? []) get(r.preset_id).hearts = r.n
	return map
}

/** Shape a stats row for the API: rating average + count + the sort score. */
export const statView = (s) => {
	const st = s ?? { installs: 0, ratings: 0, ratingSum: 0, hearts: 0 }
	return {
		installs: st.installs,
		ratings: st.ratings,
		rating: st.ratings ? Number((st.ratingSum / st.ratings).toFixed(2)) : 0,
		hearts: st.hearts,
		score: bayes(st.ratingSum, st.ratings) + st.hearts * 0.5 + Math.log10(1 + st.installs),
	}
}

// ---- anti-abuse ------------------------------------------------------------------------------
/**
 * Verify a Cloudflare Turnstile token server-side. Fails closed: no secret configured → not ok.
 * Locally, set TURNSTILE_SECRET to Cloudflare's always-passes test secret so the flow still runs.
 */
export async function turnstileVerify(token, secret, ip) {
	if (!secret) return { ok: false, reason: 'not-configured' }
	if (!token) return { ok: false, reason: 'missing-token' }
	const form = new URLSearchParams()
	form.set('secret', secret)
	form.set('response', token)
	if (ip) form.set('remoteip', ip)
	try {
		const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })
		const d = await r.json()
		return { ok: !!d.success, reason: d['error-codes']?.join(',') || null }
	} catch {
		return { ok: false, reason: 'verify-failed' }
	}
}

/** Cheap D1 rate check for the one non-idempotent write (comment post): N in the last `windowMs`. */
export async function tooManyRecent(env, table, voter, limit, windowMs) {
	const since = Date.now() - windowMs
	const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE voter = ? AND created_at >= ?`).bind(voter, since).first()
	return (row?.n ?? 0) >= limit
}
