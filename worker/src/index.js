// Vote counts for the preset library.
//
// The packs themselves are static files on Pages — this Worker exists only for the one thing a
// static file cannot do: count votes. It stores no personal data. A voter is identified by a
// salted hash of their IP, which is enough to stop one person voting a hundred times and is not
// reversible into an address.

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET,POST,OPTIONS',
	'access-control-allow-headers': 'content-type',
}

const json = (body, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...CORS },
	})

/** Non-reversible voter id. The salt is a Worker secret, so the hashes cannot be precomputed. */
async function voterId(request, env) {
	const ip = request.headers.get('cf-connecting-ip') ?? '0.0.0.0'
	const data = new TextEncoder().encode(`${ip}:${env.VOTE_SALT ?? 'unsalted'}`)
	const digest = await crypto.subtle.digest('SHA-256', data)
	return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('')
}

const PACK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export default {
	async fetch(request, env) {
		const url = new URL(request.url)

		if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })

		// Every pack's tally, for the app to merge into the static index.
		if (url.pathname === '/votes' && request.method === 'GET') {
			const { results } = await env.DB.prepare('SELECT pack_id, COUNT(*) AS votes FROM votes GROUP BY pack_id').all()
			const votes = {}
			for (const row of results ?? []) votes[row.pack_id] = row.votes
			return json({ votes, generatedAt: new Date().toISOString() })
		}

		if (url.pathname === '/vote' && request.method === 'POST') {
			let body
			try {
				body = await request.json()
			} catch {
				return json({ error: 'Expected a JSON body' }, 400)
			}
			const packId = String(body?.packId ?? '')
			if (!PACK_ID.test(packId)) return json({ error: 'Unknown pack' }, 400)

			const voter = await voterId(request, env)
			// One vote per pack per voter, ever. The primary key does the enforcing, so a repeat
			// vote is a no-op rather than an error.
			await env.DB.prepare('INSERT OR IGNORE INTO votes (pack_id, voter, created_at) VALUES (?, ?, ?)')
				.bind(packId, voter, Date.now())
				.run()
			const row = await env.DB.prepare('SELECT COUNT(*) AS votes FROM votes WHERE pack_id = ?').bind(packId).first()
			return json({ packId, votes: row?.votes ?? 0 })
		}

		return json({ error: 'Not found' }, 404)
	},
}
