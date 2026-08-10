import { json, loadCatalogue, presetStats, statView } from '../_shared.js'

// GET /api/presets?q=&mic=&style=&sort=(top|installs|new|rating)&parent=<ps_id>
// The catalogue browser's list. Reads the static preset index, merges live D1 engagement, filters,
// sorts and projects to lightweight cards (the full channel stays out of the list payload).
export async function onRequestGet({ request, env }) {
	const url = new URL(request.url)
	const q = (url.searchParams.get('q') || '').trim().toLowerCase()
	const mic = url.searchParams.get('mic') || ''
	const style = url.searchParams.get('style') || ''
	const sort = url.searchParams.get('sort') || 'top'
	const parent = url.searchParams.get('parent') || ''

	let cat
	try {
		cat = await loadCatalogue(request)
	} catch {
		return json({ error: 'The preset catalogue is unavailable' }, 503)
	}
	const stats = await presetStats(env)

	let items = (cat.presets || []).filter((p) => p.status !== 'removed')
	if (parent) items = items.filter((p) => p.variantOf === parent)
	if (mic) items = items.filter((p) => (p.mic || '') === mic)
	if (style) items = items.filter((p) => (p.style || '') === style)
	if (q) items = items.filter((p) => [p.name, p.mic, p.style, p.group, p.notes, p.author].filter(Boolean).join(' ').toLowerCase().includes(q))

	const rows = items.map((p) => {
		const sv = statView(stats[p.id])
		return {
			id: p.id,
			name: p.name,
			mic: p.mic,
			style: p.style,
			group: p.group,
			author: p.author,
			license: p.license,
			createdAt: p.createdAt,
			eq: p.channel?.eq ?? null, // the sparkline artwork
			defaultSections: p.defaultSections,
			variantOf: p.variantOf,
			variantCount: p.variantCount,
			changeNote: p.changeNote,
			rating: sv.rating,
			ratings: sv.ratings,
			installs: sv.installs,
			hearts: sv.hearts,
			_score: sv.score,
		}
	})

	const cmp =
		{
			top: (a, b) => b._score - a._score,
			installs: (a, b) => b.installs - a.installs || b._score - a._score,
			rating: (a, b) => b.rating - a.rating || b.ratings - a.ratings,
			new: (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
		}[sort] || ((a, b) => b._score - a._score)
	rows.sort(cmp)
	for (const r of rows) delete r._score

	return json({ presets: rows, total: rows.length, facets: cat.facets ?? { mics: [], styles: [] } })
}
