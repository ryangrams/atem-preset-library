import { json, voterId, loadCatalogue, loadComments, turnstileVerify, tooManyRecent, ulid, PRESET_ID, COMMENT_ID } from '../../../_shared.js'

// GET /api/presets/:id/comments — the threaded comments for a preset.
export async function onRequestGet({ request, env, params }) {
	const id = String(params.id || '')
	if (!PRESET_ID.test(id)) return json({ error: 'Unknown preset' }, 400)
	const voter = await voterId(request, env)
	return json({ comments: await loadComments(env, id, voter) })
}

// POST /api/presets/:id/comments  { body, rating?, parentId?, author?, turnstileToken, website? }
// The one non-idempotent write: free text. Gated by Turnstile + a honeypot + rate limits + caps.
export async function onRequestPost({ request, env, params }) {
	const id = String(params.id || '')
	if (!PRESET_ID.test(id)) return json({ error: 'Unknown preset' }, 400)

	let body
	try {
		body = await request.json()
	} catch {
		return json({ error: 'Expected a JSON body' }, 400)
	}

	// Honeypot: a field no real form shows. A bot that fills it gets a cheerful no-op, not an error.
	if (body?.website) return json({ ok: true, comments: [] })

	const text = String(body?.body ?? '').trim()
	if (!text) return json({ error: 'Write something first' }, 400)
	if (text.length > 2000) return json({ error: 'That is over the 2000-character limit' }, 400)
	if ((text.match(/https?:\/\//gi) || []).length > 2) return json({ error: 'Too many links — keep it to two' }, 400)

	const rating = body?.rating == null ? null : Number(body.rating)
	if (rating != null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) return json({ error: 'Rating must be a whole number 1–5' }, 400)

	const author = body?.author ? String(body.author).trim().slice(0, 60) || null : null
	const parentId = body?.parentId ? String(body.parentId) : null
	if (parentId && !COMMENT_ID.test(parentId)) return json({ error: 'That reply target is not valid' }, 400)

	let cat
	try {
		cat = await loadCatalogue(request)
	} catch {
		return json({ error: 'The preset catalogue is unavailable' }, 503)
	}
	const preset = cat.byId.get(id)
	if (!preset || preset.status === 'removed') return json({ error: 'Preset not found' }, 404)

	const voter = await voterId(request, env)

	// Turnstile — the human check, done server-side and failing closed.
	const ts = await turnstileVerify(body?.turnstileToken, env.TURNSTILE_SECRET, request.headers.get('cf-connecting-ip'))
	if (!ts.ok) return json({ error: 'Could not verify you are human. Please try again.', reason: ts.reason }, 403)

	// Rate limits on top of Turnstile: bursts and daily volume from one identity.
	if (await tooManyRecent(env, 'comments', voter, 5, 60_000)) return json({ error: 'You are posting quickly — give it a moment.' }, 429)
	if (await tooManyRecent(env, 'comments', voter, 40, 86_400_000)) return json({ error: 'You have reached the daily comment limit.' }, 429)

	// Threading: a reply is stored against the TOP-LEVEL comment; deeper replies flatten to it but
	// keep the @name they answered for context.
	let storedParent = null
	let replyToName = null
	if (parentId) {
		const par = await env.DB.prepare('SELECT id, parent_id, author, preset_id, status FROM comments WHERE id = ?').bind(parentId).first()
		if (!par || par.preset_id !== id || par.status !== 'visible') return json({ error: 'That comment is no longer here' }, 404)
		storedParent = par.parent_id || par.id
		replyToName = par.author || 'anonymous'
	}

	const cid = ulid('cm_')
	const now = Date.now()
	const stmts = [
		env.DB.prepare(
			"INSERT INTO comments (id, preset_id, parent_id, author, body, rating, reply_to_name, status, helpful_count, reply_count, voter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'visible', 0, 0, ?, ?)",
		).bind(cid, id, storedParent, author, text, rating, replyToName, voter, now),
	]
	// Keep the parent's reply_count exact and counting only VISIBLE replies (recomputed, never drifts).
	if (storedParent) stmts.push(env.DB.prepare("UPDATE comments SET reply_count = (SELECT COUNT(*) FROM comments WHERE parent_id = ? AND status = 'visible') WHERE id = ?").bind(storedParent, storedParent))
	// A comment may double as a review — one star per voter, upserted.
	if (rating != null) {
		stmts.push(
			env.DB.prepare('INSERT INTO ratings (preset_id, voter, stars, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(preset_id, voter) DO UPDATE SET stars = excluded.stars, updated_at = excluded.updated_at').bind(id, voter, rating, now),
		)
	}
	await env.DB.batch(stmts)

	return json({ ok: true, id: cid, comments: await loadComments(env, id, voter) })
}
