// Shared by the vote endpoints. These run as Cloudflare Pages Functions, on the same origin as
// the site itself — which is why there is no CORS handling here and no second deployment to keep
// in step with the first.

/** Non-reversible voter id. The salt is a project secret, so hashes cannot be precomputed. */
export async function voterId(request, env) {
	const ip = request.headers.get('cf-connecting-ip') ?? '0.0.0.0'
	const data = new TextEncoder().encode(`${ip}:${env.VOTE_SALT ?? 'unsalted'}`)
	const digest = await crypto.subtle.digest('SHA-256', data)
	return [...new Uint8Array(digest)]
		.slice(0, 16)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}

export const PACK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export const json = (body, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json',
			// The desktop app fetches this from its own local origin.
			'access-control-allow-origin': '*',
		},
	})
