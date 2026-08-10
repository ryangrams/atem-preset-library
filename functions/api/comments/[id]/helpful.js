import { json, voterId, COMMENT_ID } from '../../../_shared.js'

// POST /api/comments/:id/helpful — toggle a "Helpful" mark on a comment. One per voter; the count
// is recomputed from the set so it stays exact.
export async function onRequestPost({ request, env, params }) {
	const id = String(params.id || '')
	if (!COMMENT_ID.test(id)) return json({ error: 'Unknown comment' }, 400)

	const c = await env.DB.prepare("SELECT id, status FROM comments WHERE id = ?").bind(id).first()
	if (!c || c.status !== 'visible') return json({ error: 'Comment not found' }, 404)

	const voter = await voterId(request, env)
	const existing = await env.DB.prepare('SELECT 1 FROM comment_helpful WHERE comment_id = ? AND voter = ?').bind(id, voter).first()
	const toggle = existing
		? env.DB.prepare('DELETE FROM comment_helpful WHERE comment_id = ? AND voter = ?').bind(id, voter)
		: env.DB.prepare('INSERT OR IGNORE INTO comment_helpful (comment_id, voter, created_at) VALUES (?, ?, ?)').bind(id, voter, Date.now())
	await env.DB.batch([toggle, env.DB.prepare('UPDATE comments SET helpful_count = (SELECT COUNT(*) FROM comment_helpful WHERE comment_id = ?) WHERE id = ?').bind(id, id)])

	const row = await env.DB.prepare('SELECT helpful_count FROM comments WHERE id = ?').bind(id).first()
	return json({ id, helpful: row?.helpful_count ?? 0, youHelpful: !existing })
}
