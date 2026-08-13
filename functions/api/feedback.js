import { json, voterId, turnstileVerify, tooManyRecent, ulid } from '../_shared.js'

// POST /api/feedback — the in-app Feedback button. Files a GitHub issue on the app repo so the
// reporter needs no GitHub account of their own. Public write, so it is gated like comments:
// Turnstile + honeypot + rate limit + caps. An opt-in screenshot goes to R2 and is embedded in the
// issue. Nothing here can touch a switcher.

const KINDS = { bug: { label: 'bug', word: 'Bug report' }, idea: { label: 'enhancement', word: 'Idea / suggestion' } }
const clamp = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')

/** Decode a `data:image/(png|jpeg);base64,…` URL to bytes, or null if it is not one. */
function decodeImage(dataUrl) {
	const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''))
	if (!m) return null
	const bin = atob(m[2])
	const bytes = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
	return { bytes, contentType: m[1] }
}

export async function onRequestPost({ request, env }) {
	if (!env.GITHUB_FEEDBACK_TOKEN) return json({ error: 'Feedback is not configured yet' }, 503)

	let body
	try {
		body = await request.json()
	} catch {
		return json({ error: 'Expected a JSON body' }, 400)
	}

	// Honeypot — a field no real form shows.
	if (body?.website) return json({ ok: true })

	const kind = KINDS[body?.kind] ? body.kind : 'bug'
	const message = clamp(body?.message, 5000).trim()
	if (!message) return json({ error: 'Please describe the bug or idea' }, 400)
	const email = clamp(body?.email, 200).trim()
	if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'That email does not look right' }, 400)

	const ctx = body?.context ?? {}
	const context = {
		appVersion: clamp(ctx.appVersion, 40),
		platform: clamp(ctx.platform, 60),
		atem: clamp(ctx.atem, 120),
		view: clamp(ctx.view, 80),
	}

	const voter = await voterId(request, env)

	// Turnstile (fail closed) then per-person rate limits — filing issues is expensive to clean up.
	const ts = await turnstileVerify(body?.turnstileToken, env.TURNSTILE_SECRET, request.headers.get('cf-connecting-ip'))
	if (!ts.ok) return json({ error: 'Could not verify you are human. Please try again.', reason: ts.reason }, 403)
	if (await tooManyRecent(env, 'feedback', voter, 3, 60 * 60_000)) return json({ error: 'Thanks — you have sent a few just now. Try again in a little while.' }, 429)
	if (await tooManyRecent(env, 'feedback', voter, 10, 24 * 60 * 60_000)) return json({ error: 'You have reached the daily feedback limit.' }, 429)

	// GLOBAL circuit breaker: a hard ceiling on total reports across everyone per day, so distributed
	// abuse (many IPs, each under the per-person limit) still cannot run up R2 storage or spam the
	// issue tracker. Tunable without a redeploy via the FEEDBACK_DAILY_CAP var. At the default 200/day
	// the whole system stays deep inside R2's free tier no matter what.
	const dailyCap = Number(env.FEEDBACK_DAILY_CAP) || 200
	const dayAgo = Date.now() - 24 * 60 * 60_000
	const globalToday = await env.DB.prepare('SELECT COUNT(*) AS n FROM feedback WHERE created_at >= ?').bind(dayAgo).first()
	if ((globalToday?.n ?? 0) >= dailyCap) return json({ error: 'We have had a lot of feedback today — please try again tomorrow. Thank you!' }, 429)

	// Optional screenshot → R2 (public), embedded in the issue.
	let imageUrl = null
	if (body?.screenshot) {
		const img = decodeImage(body.screenshot)
		if (!img) return json({ error: 'The screenshot was not a valid image' }, 400)
		if (img.bytes.length > 5_000_000) return json({ error: 'That screenshot is too large' }, 400)
		if (env.FEEDBACK_BUCKET && env.FEEDBACK_PUBLIC_URL) {
			const key = `shots/${ulid('s_')}.${img.contentType === 'image/png' ? 'png' : 'jpg'}`
			await env.FEEDBACK_BUCKET.put(key, img.bytes, { httpMetadata: { contentType: img.contentType } })
			imageUrl = `${env.FEEDBACK_PUBLIC_URL.replace(/\/$/, '')}/${key}`
		}
		// If R2 is not configured, the report still files — just without the image.
	}

	// Build and file the GitHub issue.
	const repo = env.GITHUB_FEEDBACK_REPO || 'ryangrams/atem-audio-presets'
	const meta = KINDS[kind]
	const firstLine = message.split('\n')[0].slice(0, 80)
	const title = `[${kind === 'bug' ? 'Bug' : 'Idea'}] ${firstLine}`
	const issueBody = [
		message,
		'',
		'---',
		`- **Type:** ${meta.word}`,
		context.appVersion ? `- **App version:** ${context.appVersion}` : '',
		context.platform ? `- **Platform:** ${context.platform}` : '',
		context.atem ? `- **Switcher:** ${context.atem}` : '',
		context.view ? `- **View:** ${context.view}` : '',
		email ? `- **Reporter:** ${email}` : '',
		'',
		imageUrl ? `![screenshot](${imageUrl})` : '',
		'',
		'_Filed from the in-app Feedback button._',
	]
		.filter((l) => l !== '')
		.join('\n')

	const gh = await fetch(`https://api.github.com/repos/${repo}/issues`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${env.GITHUB_FEEDBACK_TOKEN}`,
			accept: 'application/vnd.github+json',
			'user-agent': 'atem-audio-presets-feedback',
			'x-github-api-version': '2022-11-28',
			'content-type': 'application/json',
		},
		body: JSON.stringify({ title, body: issueBody, labels: [meta.label, 'feedback'] }),
	})
	if (!gh.ok) {
		const detail = await gh.text().catch(() => '')
		return json({ error: 'Could not file the report just now. Please try again.', status: gh.status, detail: detail.slice(0, 200) }, 502)
	}
	const issue = await gh.json()

	await env.DB.prepare('INSERT INTO feedback (id, voter, kind, issue, created_at) VALUES (?, ?, ?, ?, ?)').bind(ulid('fb_'), voter, kind, issue.number ?? null, Date.now()).run()

	return json({ ok: true, url: issue.html_url, number: issue.number })
}
