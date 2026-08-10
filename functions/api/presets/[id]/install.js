import { json, voterId, loadCatalogue, PRESET_ID } from '../../../_shared.js'

// POST /api/presets/:id/install — record that this person added the preset to their library.
// One per voter, ever (INSERT OR IGNORE): the count is distinct adopters, not raw clicks.
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
	await env.DB.prepare('INSERT OR IGNORE INTO installs (preset_id, voter, created_at) VALUES (?, ?, ?)').bind(id, voter, Date.now()).run()
	const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM installs WHERE preset_id = ?').bind(id).first()
	return json({ id, installs: row?.n ?? 0 })
}
