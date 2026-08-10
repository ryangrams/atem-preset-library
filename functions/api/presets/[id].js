import { json, loadCatalogue, presetStats, statView, voterId, loadComments, PRESET_ID } from '../../_shared.js'

// GET /api/presets/:id — the detail page. Static preset + live engagement + this voter's own
// rating/heart, the variants forked from it (each with its own stats), the parent it forked from
// (if any), and the threaded comments.
export async function onRequestGet({ request, env, params }) {
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

	const stats = await presetStats(env)
	const sv = statView(stats[id])
	const voter = await voterId(request, env)

	const [yr, yh] = await Promise.all([
		env.DB.prepare('SELECT stars FROM ratings WHERE preset_id = ? AND voter = ?').bind(id, voter).first(),
		env.DB.prepare('SELECT 1 FROM hearts WHERE preset_id = ? AND voter = ?').bind(id, voter).first(),
	])

	const variants = (cat.children?.[id] ?? [])
		.map((cid) => cat.byId.get(cid))
		.filter((v) => v && v.status !== 'removed')
		.map((v) => {
			const vv = statView(stats[v.id])
			return {
				id: v.id,
				name: v.name,
				mic: v.mic,
				style: v.style,
				author: v.author,
				changeNote: v.changeNote,
				eq: v.channel?.eq ?? null,
				createdAt: v.createdAt,
				rating: vv.rating,
				ratings: vv.ratings,
				installs: vv.installs,
				hearts: vv.hearts,
				_score: vv.score,
			}
		})
		.sort((a, b) => b._score - a._score)
	for (const v of variants) delete v._score

	let parent = null
	if (p.variantOf) {
		const par = cat.byId.get(p.variantOf)
		if (par) parent = { id: par.id, name: par.name, author: par.author, status: par.status }
	}

	return json({
		id: p.id,
		name: p.name,
		mic: p.mic,
		style: p.style,
		group: p.group,
		author: p.author,
		license: p.license,
		createdAt: p.createdAt,
		notes: p.notes,
		device: p.device,
		sampleUrl: p.sampleUrl,
		defaultSections: p.defaultSections,
		channel: p.channel,
		// what a fork of THIS preset needs to record its lineage
		packId: p.packId,
		contentHash: p.contentHash,
		// lineage
		forkedFrom: p.forkedFrom,
		variantOf: p.variantOf,
		parent,
		originalAuthor: p.originalAuthor,
		attribution: p.attribution,
		changeNote: p.changeNote,
		lineageRoot: p.lineageRoot,
		variantCount: p.variantCount,
		variants,
		// engagement
		rating: sv.rating,
		ratings: sv.ratings,
		installs: sv.installs,
		hearts: sv.hearts,
		yourRating: yr?.stars ?? null,
		youHearted: !!yh,
		comments: await loadComments(env, id, voter),
	})
}
