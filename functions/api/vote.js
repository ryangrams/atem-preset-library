import { json, PACK_ID, voterId, tooManyRecent } from '../_shared.js'

export async function onRequestPost({ request, env }) {
	let body
	try {
		body = await request.json()
	} catch {
		return json({ error: 'Expected a JSON body' }, 400)
	}
	const packId = String(body?.packId ?? '')
	if (!PACK_ID.test(packId)) return json({ error: 'Unknown pack' }, 400)

	// The pack must actually be in the catalogue. Without this, a loop of fabricated but regex-valid
	// ids would insert unbounded rows and inject fake tallies into the public vote feed.
	let exists = false
	try {
		const res = await fetch(new URL('/index.json', request.url), { cf: { cacheTtl: 60, cacheEverything: true } })
		if (res.ok) {
			const idx = await res.json()
			exists = (idx.packs ?? []).some((p) => p.id === packId)
		}
	} catch {
		/* an unreachable index means we cannot confirm — reject below rather than accept blindly */
	}
	if (!exists) return json({ error: 'Unknown pack' }, 404)

	const voter = await voterId(request, env)
	if (await tooManyRecent(env, 'votes', voter, 30, 60_000)) return json({ error: 'You are voting very quickly — give it a moment.' }, 429)

	// One vote per pack per voter, ever. The primary key enforces it, so a repeat vote is a no-op.
	await env.DB.prepare('INSERT OR IGNORE INTO votes (pack_id, voter, created_at) VALUES (?, ?, ?)').bind(packId, voter, Date.now()).run()
	const row = await env.DB.prepare('SELECT COUNT(*) AS votes FROM votes WHERE pack_id = ?').bind(packId).first()
	return json({ packId, votes: row?.votes ?? 0 })
}
