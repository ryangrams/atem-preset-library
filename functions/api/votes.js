import { json } from '../_shared.js'

/** Every pack's tally, for the site and the app to merge into the static index. */
export async function onRequestGet({ env }) {
	const { results } = await env.DB.prepare('SELECT pack_id, COUNT(*) AS votes FROM votes GROUP BY pack_id').all()
	const votes = {}
	for (const row of results ?? []) votes[row.pack_id] = row.votes
	return json({ votes, generatedAt: new Date().toISOString() })
}
