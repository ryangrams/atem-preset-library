// Validates every pack in packs/ and writes the files the site and app fetch:
//   site/index.json    — PACK-based, for the landing page (unchanged shape).
//   site/presets.json  — a flat PRESET index: one entry per preset, plus facets, a parent→children
//                        variant map and aliases. This is what the app's Pages Functions read.
//   site/aliases.json  — slug → id, so a renamed preset's old URL can still resolve.
//   site/packs/*.json  — the raw pack files, copied for direct download.
//
// Submissions arrive as pull requests from strangers, so this is the gate: a pack that does not
// match the shape below never reaches the index, and only known fields are copied forward. Run by
// CI on every PR (--check, validate only) and on merge (validate + write).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const ROOT = path.join(import.meta.dirname, '..')
const PACK_DIR = path.join(ROOT, 'packs')
const SITE = path.join(ROOT, 'site')
const writeMode = !process.argv.includes('--check')

const SECTIONS = ['gain', 'volume', 'pan', 'eq', 'dynamics', 'inputConfig']
const PRESET_ID = /^ps_[0-9a-z]{26}$/
const STATUSES = ['visible', 'removed']
const errors = []
const warnings = []
const fail = (file, msg) => errors.push(`${file}: ${msg}`)
const warn = (file, msg) => warnings.push(`${file}: ${msg}`)

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isInt = (v) => isNum(v) && Number.isInteger(v)
const isStr = (v) => typeof v === 'string'

/** Deterministic serialisation (sorted keys) so a content hash is stable regardless of key order. */
function stable(v) {
	if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
	if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
	return JSON.stringify(v)
}
const contentHashOf = (channel) => 'sha256:' + crypto.createHash('sha256').update(stable(channel ?? null)).digest('hex').slice(0, 32)
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'preset'
// Submissions are attacker-controlled, so every string that reaches the served index is length-capped
// and a link is only kept if it is an http(s) URL.
const capStr = (v, n) => (isStr(v) ? v.slice(0, n) : v == null ? null : String(v).slice(0, n))
const httpUrl = (v) => (isStr(v) && /^https?:\/\/\S+$/i.test(v) ? v.slice(0, 500) : null)

/** A band as the switcher stores it: integer dB×100, Hz, Q×100. */
function checkBand(file, b, i) {
	if (b === null) return
	if (typeof b !== 'object') return fail(file, `band ${i} is not an object`)
	if (typeof b.bandEnabled !== 'boolean') fail(file, `band ${i} missing bandEnabled`)
	for (const k of ['shape', 'frequency', 'gain', 'qFactor']) {
		if (!isInt(b[k])) fail(file, `band ${i} ${k} must be an integer`)
	}
	if (![1, 2, 4, 8, 16, 32].includes(b.shape)) fail(file, `band ${i} has an unknown shape ${b.shape}`)
	if (b.frequency < 10 || b.frequency > 30000) fail(file, `band ${i} frequency ${b.frequency} is out of range`)
	if (Math.abs(b.gain) > 2000) fail(file, `band ${i} gain ${b.gain} is out of range`)
}

function checkChannel(file, ch) {
	if (!ch || typeof ch !== 'object') return fail(file, 'preset has no channel')
	if (!ch.meta || typeof ch.meta !== 'object') fail(file, 'channel has no meta')
	if (ch.levels) {
		for (const [k, v] of Object.entries(ch.levels)) {
			if (v !== undefined && v !== null && !isNum(v)) fail(file, `levels.${k} must be a number`)
		}
		// A preset that carries an on/off state would mute someone's channel on paste.
		if ('mixOption' in ch.levels && ch.levels.mixOption !== undefined) {
			fail(file, 'levels.mixOption must not be published — on/off is never copied')
		}
	}
	if (ch.eq) {
		if (typeof ch.eq.enabled !== 'boolean') fail(file, 'eq.enabled must be a boolean')
		if (!Array.isArray(ch.eq.bands)) fail(file, 'eq.bands must be an array')
		else {
			if (ch.eq.bands.length > 8) fail(file, `eq has ${ch.eq.bands.length} bands, more than any ATEM`)
			ch.eq.bands.forEach((b, i) => checkBand(file, b, i))
		}
	}
	if (ch.dynamics) {
		for (const unit of ['compressor', 'limiter', 'expander']) {
			const u = ch.dynamics[unit]
			if (u == null) continue
			if (typeof u !== 'object') fail(file, `dynamics.${unit} must be an object`)
			else
				for (const [k, v] of Object.entries(u)) {
					if (typeof v !== 'boolean' && !isNum(v)) fail(file, `dynamics.${unit}.${k} is not a number or boolean`)
				}
		}
	}
}

// ---- pass 1: load & validate packs, explode into a flat preset list --------------------------

const packs = []
const presets = [] // flat, one entry per preset
const byId = new Map() // id -> flat entry (for fork resolution)

// An empty library is a valid state — it is how this starts.
const packFiles = fs.existsSync(PACK_DIR) ? fs.readdirSync(PACK_DIR).filter((f) => f.endsWith('.json')).sort() : []
for (const file of packFiles) {
	const full = path.join(PACK_DIR, file)
	let body
	try {
		body = JSON.parse(fs.readFileSync(full, 'utf8'))
	} catch (e) {
		fail(file, `is not valid JSON (${e.message})`)
		continue
	}

	if (body.format !== 'atem-audio-preset-pack') fail(file, 'format must be "atem-audio-preset-pack"')
	if (!body.name || typeof body.name !== 'string') fail(file, 'needs a name')
	if (!Array.isArray(body.presets) || !body.presets.length) fail(file, 'needs at least one preset')
	if (body.presets?.length > 60) fail(file, 'has more than 60 presets — split it up')

	const packId = file.replace(/\.json$/, '')

	for (const p of body.presets ?? []) {
		if (!p?.name) fail(file, 'a preset has no name')
		checkChannel(file, p?.channel)
		if (p?.defaultSections) {
			for (const k of Object.keys(p.defaultSections)) {
				if (!SECTIONS.includes(k)) fail(file, `unknown section "${k}" in defaultSections`)
			}
		}

		// --- preset identity: the anchor every rating, heart, install and comment hangs off ---
		const id = p?.id
		if (!isStr(id) || !PRESET_ID.test(id)) {
			fail(file, `preset "${p?.name ?? '?'}" needs a stable id of the form ps_<26 chars> (got ${JSON.stringify(id)})`)
		} else if (byId.has(id)) {
			fail(file, `preset id ${id} is used more than once — ids must be unique`)
		}

		// --- licence: default to the repo's MIT; a fork must preserve it (checked in pass 2) ---
		const license = isStr(p?.license) && p.license.trim() ? p.license.trim() : 'MIT'

		// --- status / tombstone ---
		const status = STATUSES.includes(p?.status) ? p.status : 'visible'

		// --- fork lineage (shape only here; resolution against other presets is pass 2) ---
		let forkedFrom = null
		if (p?.forkedFrom != null) {
			const ff = p.forkedFrom
			if (typeof ff !== 'object' || !isStr(ff.id) || !PRESET_ID.test(ff.id)) {
				fail(file, `preset "${p.name}" has a forkedFrom without a valid parent id`)
			} else {
				forkedFrom = { id: ff.id, packId: isStr(ff.packId) ? ff.packId : null, version: isStr(ff.version) ? ff.version : null }
			}
			if (!isStr(p?.changeNote) || !p.changeNote.trim()) fail(file, `variant "${p.name}" must say what changed (changeNote)`)
			if (!Array.isArray(p?.attribution) || !p.attribution.length) fail(file, `variant "${p.name}" must credit prior authors (attribution)`)
			if (p?.originalAuthor == null) fail(file, `variant "${p.name}" must name the original author (originalAuthor)`)
		}

		// A bounded, serialisable channel — so a giant or pathologically-nested payload can neither
		// bloat the served index nor overflow the recursive hasher below.
		let channelJson = 'null'
		try {
			channelJson = JSON.stringify(p.channel ?? null)
		} catch {
			fail(file, `preset "${p?.name ?? '?'}" has a channel that cannot be serialised`)
		}
		if (channelJson.length > 20000) fail(file, `preset "${p?.name ?? '?'}" channel is too large (${channelJson.length} bytes)`)

		if (errors.length) continue // don't index a pack with problems; keep collecting errors

		const entry = {
			id,
			slug: slugify(p.name),
			name: capStr(p.name, 200),
			group: capStr(p.group ?? '', 100) ?? '',
			mic: capStr(p.mic, 120),
			style: capStr(p.style, 120),
			author: capStr(p.author, 120),
			license,
			status,
			defaultSections: p.defaultSections ?? null,
			device: p.device ? { model: capStr(p.device.model, 120), release: capStr(p.device.release, 60), build: capStr(p.device.build, 60) } : null,
			sampleUrl: httpUrl(p.sampleUrl),
			notes: capStr(p.notes, 4000),
			channel: p.channel, // full — the detail view needs it; the list Function strips it
			forkedFrom,
			lineageRoot: isStr(p?.lineageRoot) && PRESET_ID.test(p.lineageRoot) ? p.lineageRoot : forkedFrom?.id ?? null,
			variantOf: forkedFrom?.id ?? null,
			variantCount: 0, // filled in pass 2
			changeNote: forkedFrom ? capStr(p.changeNote, 2000) : null,
			originalAuthor: p.originalAuthor ?? null,
			attribution: Array.isArray(p.attribution) ? p.attribution.filter(isStr).map((a) => a.slice(0, 120)).slice(0, 20) : [],
			createdAt: capStr(p.createdAt ?? body.createdAt, 40),
			contentHash: contentHashOf(p.channel),
			packId,
		}
		presets.push(entry)
		byId.set(id, entry)
	}
	if (errors.length) continue

	// PACK summary — the landing page's shape, unchanged.
	packs.push({
		id: packId,
		file: `packs/${file}`,
		name: body.name,
		description: typeof body.description === 'string' ? body.description.slice(0, 2000) : '',
		author: typeof body.author === 'string' ? body.author.slice(0, 120) : '',
		tags: Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === 'string').slice(0, 8) : [],
		presetCount: body.presets.length,
		presets: body.presets.map((p) => ({ name: p.name, group: p.group ?? '' })),
		devices: [...new Set(body.presets.map((p) => p.device?.model).filter(Boolean))],
		createdAt: body.createdAt ?? null,
		checksum: crypto.createHash('sha256').update(JSON.stringify(body.presets)).digest('hex').slice(0, 16),
	})
}

// ---- pass 2: resolve variant lineage now that every id is known ------------------------------

const children = {} // parentId -> [childId]
for (const e of presets) {
	if (!e.variantOf) continue
	const parent = byId.get(e.variantOf)
	if (!parent) {
		fail(e.packId, `variant "${e.name}" forks ${e.variantOf}, which is not in the library`)
		continue
	}
	if (parent.status === 'removed') {
		// A tombstoned parent still anchors its children — provenance survives a takedown.
		warn(e.packId, `variant "${e.name}" forks a removed preset (${e.variantOf}); lineage kept`)
	}
	// Anti-laundering: you may not relabel someone else's work as your own original.
	const claimed = e.originalAuthor && (e.originalAuthor.name ?? e.originalAuthor.handle ?? e.originalAuthor)
	const parentAuthor = parent.originalAuthor?.name ?? parent.originalAuthor?.handle ?? parent.originalAuthor ?? parent.author
	if (claimed && parentAuthor && String(claimed).trim().toLowerCase() !== String(parentAuthor).trim().toLowerCase()) {
		fail(e.packId, `variant "${e.name}" credits "${claimed}" as the original author, but ${e.variantOf} is by "${parentAuthor}"`)
	}
	// Licence must be preserved, not dropped or swapped.
	if (e.license !== parent.license) {
		fail(e.packId, `variant "${e.name}" changes the licence from ${parent.license} to ${e.license} — a fork must keep the original licence`)
	}
	;(children[e.variantOf] ??= []).push(e.id)
}
for (const e of presets) e.variantCount = (children[e.id] ?? []).length

// Undeclared copies: identical channel data across presets is only allowed when they form an open
// fork chain (one declares the other as its parent, or they share a common parent that is also
// present). Otherwise it is someone re-publishing another's work without the attribution/licence
// gates above — reject it, so the contentHash we compute for everyone actually earns its keep.
const byHash = new Map()
for (const e of presets) (byHash.get(e.contentHash) ?? byHash.set(e.contentHash, []).get(e.contentHash)).push(e)
for (const group of byHash.values()) {
	if (group.length < 2) continue
	const ids = new Set(group.map((g) => g.id))
	for (const e of group) {
		const declaresWithin = e.variantOf && ids.has(e.variantOf) // e forks another in the group
		const parentOfOne = group.some((g) => g.variantOf === e.id) // another in the group forks e
		if (!declaresWithin && !parentOfOne) {
			const other = group.find((g) => g.id !== e.id)
			fail(e.packId, `preset "${e.name}" (${e.id}) has channel data identical to "${other.name}" (${other.id}) but does not declare it as a fork — an undeclared copy`)
		}
	}
}

// ---- facets + aliases ------------------------------------------------------------------------

const countBy = (key) => {
	const m = new Map()
	for (const e of presets) {
		const v = e[key]
		if (!v || e.status === 'removed') continue
		m.set(v, (m.get(v) ?? 0) + 1)
	}
	return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

// Prototype-less, so a preset whose slug is "constructor" or "__proto__" can't collide with an
// inherited Object property and silently lose its alias.
const aliases = Object.create(null)
for (const e of presets) if (!(e.slug in aliases)) aliases[e.slug] = e.id

// ---- report + write --------------------------------------------------------------------------

if (warnings.length) console.warn(`⚠ ${warnings.length} warning${warnings.length === 1 ? '' : 's'}:\n` + warnings.map((w) => `  - ${w}`).join('\n'))
if (errors.length) {
	console.error(`✗ ${errors.length} problem${errors.length === 1 ? '' : 's'}:\n` + errors.map((e) => `  - ${e}`).join('\n'))
	process.exit(1)
}

const generatedAt = process.env.INDEX_TIMESTAMP ?? new Date().toISOString()

const index = { format: 'atem-audio-preset-index', version: 1, generatedAt, packCount: packs.length, packs }
const presetIndex = {
	format: 'atem-audio-preset-catalogue',
	version: 1,
	generatedAt,
	presetCount: presets.filter((p) => p.status !== 'removed').length,
	facets: { mics: countBy('mic'), styles: countBy('style') },
	children,
	presets,
}

if (writeMode) {
	fs.mkdirSync(path.join(SITE, 'packs'), { recursive: true })
	fs.writeFileSync(path.join(SITE, 'index.json'), JSON.stringify(index, null, 2))
	fs.writeFileSync(path.join(SITE, 'presets.json'), JSON.stringify(presetIndex, null, 2))
	fs.writeFileSync(path.join(SITE, 'aliases.json'), JSON.stringify(aliases, null, 2))
	for (const p of packs) fs.copyFileSync(path.join(ROOT, p.file), path.join(SITE, p.file))
	console.log(`✓ ${packs.length} pack${packs.length === 1 ? '' : 's'}, ${presetIndex.presetCount} preset${presetIndex.presetCount === 1 ? '' : 's'} → site/index.json + site/presets.json`)
} else {
	console.log(`✓ ${packs.length} pack${packs.length === 1 ? '' : 's'}, ${presetIndex.presetCount} preset${presetIndex.presetCount === 1 ? '' : 's'} valid`)
}
