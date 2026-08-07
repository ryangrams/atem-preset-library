// Validates every pack in packs/ and writes site/index.json — the single file the app fetches.
//
// Submissions arrive as pull requests from strangers, so this is the gate: a pack that does not
// match the shape below never reaches the index, and only known fields are copied forward. Run
// by CI on every PR (validate only) and on merge (validate + write).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const ROOT = path.join(import.meta.dirname, '..')
const PACK_DIR = path.join(ROOT, 'packs')
const OUT = path.join(ROOT, 'site', 'index.json')
const writeMode = !process.argv.includes('--check')

const SECTIONS = ['gain', 'volume', 'pan', 'eq', 'dynamics', 'inputConfig']
const errors = []
const fail = (file, msg) => errors.push(`${file}: ${msg}`)

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isInt = (v) => isNum(v) && Number.isInteger(v)

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

const packs = []
for (const file of fs.readdirSync(PACK_DIR).filter((f) => f.endsWith('.json')).sort()) {
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

	for (const p of body.presets ?? []) {
		if (!p?.name) fail(file, 'a preset has no name')
		checkChannel(file, p?.channel)
		if (p?.defaultSections) {
			for (const k of Object.keys(p.defaultSections)) {
				if (!SECTIONS.includes(k)) fail(file, `unknown section "${k}" in defaultSections`)
			}
		}
	}
	if (errors.length) continue

	// The id is stable across edits to descriptive fields, so votes survive a typo fix.
	const id = file.replace(/\.json$/, '')
	packs.push({
		id,
		file: `packs/${file}`,
		name: body.name,
		description: typeof body.description === 'string' ? body.description.slice(0, 2000) : '',
		author: typeof body.author === 'string' ? body.author.slice(0, 120) : '',
		tags: Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === 'string').slice(0, 8) : [],
		presetCount: body.presets.length,
		presets: body.presets.map((p) => ({ name: p.name, group: p.group ?? '' })),
		// What hardware it came off, which is what tells you whether it suits yours.
		devices: [...new Set(body.presets.map((p) => p.device?.model).filter(Boolean))],
		createdAt: body.createdAt ?? null,
		checksum: crypto.createHash('sha256').update(JSON.stringify(body.presets)).digest('hex').slice(0, 16),
	})
}

if (errors.length) {
	console.error(`✗ ${errors.length} problem${errors.length === 1 ? '' : 's'}:\n` + errors.map((e) => `  - ${e}`).join('\n'))
	process.exit(1)
}

const index = {
	format: 'atem-audio-preset-index',
	version: 1,
	generatedAt: process.env.INDEX_TIMESTAMP ?? new Date().toISOString(),
	packCount: packs.length,
	packs,
}

if (writeMode) {
	fs.mkdirSync(path.dirname(OUT), { recursive: true })
	fs.writeFileSync(OUT, JSON.stringify(index, null, 2))
	for (const p of packs) {
		fs.mkdirSync(path.join(ROOT, 'site', 'packs'), { recursive: true })
		fs.copyFileSync(path.join(ROOT, p.file), path.join(ROOT, 'site', p.file))
	}
	console.log(`✓ ${packs.length} pack${packs.length === 1 ? '' : 's'} → site/index.json`)
} else {
	console.log(`✓ ${packs.length} pack${packs.length === 1 ? '' : 's'} valid`)
}
