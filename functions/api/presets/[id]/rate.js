import { json, voterId, loadCatalogue, PRESET_ID } from '../../../_shared.js'

// POST /api/presets/:id/rate  { rating: 1..5 }
// One upsertable star per voter — rating again just changes your star, never adds a second.
export async function onRequestPost({ request, env, params }) {
	const id = String(params.id || '')
	if (!PRESET_ID.test(id)) return json({ error: 'Unknown preset' }, 400)

	let body
	try {
		body = await request.json()
	} catch {
		return json({ error: 'Expected a JSON body' }, 400)
	}
	const stars = Number(body?.rating)
	if (!Number.isInteger(stars) || stars < 1 || stars > 5) return json({ error: 'Rating must be a whole number 1–5' }, 400)

	let cat
	try {
		cat = await loadCatalogue(request)
	} catch {
		return json({ error: 'The preset catalogue is unavailable' }, 503)
	}
	const p = cat.byId.get(id)
	if (!p || p.status === 'removed') return json({ error: 'Preset not found' }, 404)

	const voter = await voterId(request, env)
	await env.DB.prepare(
		'INSERT INTO ratings (preset_id, voter, stars, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(preset_id, voter) DO UPDATE SET stars = excluded.stars, updated_at = excluded.updated_at',
	)
		.bind(id, voter, stars, Date.now())
		.run()

	const row = await env.DB.prepare('SELECT COUNT(*) AS n, SUM(stars) AS s FROM ratings WHERE preset_id = ?').bind(id).first()
	const rating = row?.n ? Number((row.s / row.n).toFixed(2)) : 0
	return json({ id, rating, ratings: row?.n ?? 0, yourRating: stars })
}
