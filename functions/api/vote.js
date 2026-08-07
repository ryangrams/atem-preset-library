import { json, PACK_ID, voterId } from '../_shared.js'

export async function onRequestPost({ request, env }) {
	let body
	try {
		body = await request.json()
	} catch {
		return json({ error: 'Expected a JSON body' }, 400)
	}
	const packId = String(body?.packId ?? '')
	if (!PACK_ID.test(packId)) return json({ error: 'Unknown pack' }, 400)

	// One vote per pack per voter, ever. The primary key enforces it, so a repeat vote is a
	// no-op rather than an error.
	const voter = await voterId(request, env)
	await env.DB.prepare('INSERT OR IGNORE INTO votes (pack_id, voter, created_at) VALUES (?, ?, ?)')
		.bind(packId, voter, Date.now())
		.run()
	const row = await env.DB.prepare('SELECT COUNT(*) AS votes FROM votes WHERE pack_id = ?').bind(packId).first()
	return json({ packId, votes: row?.votes ?? 0 })
}
