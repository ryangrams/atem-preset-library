import { json, voterId, loadComments, COMMENT_ID } from '../../_shared.js'

// DELETE /api/comments/:id — retract your own comment. "Yours" = posted from the same salted-IP
// identity. Soft-hide (status = 'removed') rather than hard delete, so moderation and takedowns use
// the same mechanism; any replies simply promote to top-level rather than vanishing.
export async function onRequestDelete({ request, env, params }) {
	const id = String(params.id || '')
	if (!COMMENT_ID.test(id)) return json({ error: 'Unknown comment' }, 400)

	const voter = await voterId(request, env)
	const c = await env.DB.prepare('SELECT id, voter, preset_id, parent_id, status FROM comments WHERE id = ?').bind(id).first()
	if (!c || c.status !== 'visible') return json({ error: 'Comment not found' }, 404)
	if (c.voter !== voter) return json({ error: 'You can only remove your own comment' }, 403)

	await env.DB.prepare("UPDATE comments SET status = 'removed', body = '', author = NULL WHERE id = ?").bind(id).run()
	// If this was a reply, keep its parent's reply_count honest.
	if (c.parent_id) {
		await env.DB.prepare("UPDATE comments SET reply_count = (SELECT COUNT(*) FROM comments WHERE parent_id = ? AND status = 'visible') WHERE id = ?").bind(c.parent_id, c.parent_id).run()
	}
	return json({ ok: true, comments: await loadComments(env, c.preset_id, voter) })
}
