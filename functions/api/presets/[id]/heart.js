import { json, voterId, loadCatalogue, PRESET_ID } from '../../../_shared.js'

// POST /api/presets/:id/heart — toggle "Favorite". Present → remove, absent → add. Idempotent by key.
export async function onRequestPost({ request, env, params }) {
	const id = String(params.id || '')
	if (!PRESET_ID.test(id)) return json({ error: 'Unknown preset' }, 400)

	let cat
	try {
		cat = await loadCatalogue(request)
	} catch {
		return json({ error: 'The preset catalogue is unavailable' }, 503)
	}
	const p = cat.byId.get(id)
	if (!p || p.status === 'removed') return json({ error: 'Preset not found' }, 404)

	const voter = await voterId(request, env)
	const existing = await env.DB.prepare('SELECT 1 FROM hearts WHERE preset_id = ? AND voter = ?').bind(id, voter).first()
	if (existing) {
		await env.DB.prepare('DELETE FROM hearts WHERE preset_id = ? AND voter = ?').bind(id, voter).run()
	} else {
		await env.DB.prepare('INSERT OR IGNORE INTO hearts (preset_id, voter, created_at) VALUES (?, ?, ?)').bind(id, voter, Date.now()).run()
	}
	const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM hearts WHERE preset_id = ?').bind(id).first()
	return json({ id, hearts: row?.n ?? 0, youHearted: !existing })
}
