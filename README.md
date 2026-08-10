# ATEM Audio Preset Library

Shared Fairlight audio chains for Blackmagic ATEM switchers — gain, volume, pan, EQ and dynamics —
in a form [ATEM Audio Presets](https://github.com/ryangrams/atem-audio-presets) can load directly.

Browse them at **[presets.studioupgrade.com](https://presets.studioupgrade.com)**.

## Submitting a pack

1. In ATEM Audio Presets, put the library in a column, group the presets you want to share, and
   press the **⤓** on the group header (or **Export all**). You get one `.json` pack.
2. Fork this repo, drop the file in `packs/`, and open a pull request.
3. CI validates the pack. A human reads it. It goes live on merge.

Add `description`, `author` and `tags` to the file if you like — they show up in the listing:

```json
{
  "format": "atem-audio-preset-pack",
  "name": "Podcast starter pack",
  "description": "Mic chains for a two-person show on an ATEM Mini Extreme",
  "author": "Your name",
  "tags": ["podcast", "mic"],
  "presets": [ … ]
}
```

## What a pack may contain

Presets are **data, never instructions**. The validator (`scripts/build-index.mjs`) accepts only
known fields with plausible values, and the app ignores anything it does not recognise.

- A stable preset `id` of the form `ps_<26 chars>`, and a `license` (SPDX, defaults to `MIT`). The
  app mints the id once when you create a preset; it is opaque content identity — the anchor a
  preset's ratings, favourites and comments hang off — never anything that identifies a person or a
  device.
- Levels, EQ bands and dynamics as the switcher stores them: integers, dB and Q scaled ×100,
  frequency in Hz.
- The switcher model and firmware build a preset came from, so people can judge whether it suits
  their hardware.
- **Never** a channel's on/off state — that is a live operating control, and pasting one would
  mute someone mid-show. Packs containing it are rejected.
- Nothing identifying about a person or device: no addresses, no serial numbers, no ATEM unique ids.

## Variants (forks)

A great preset is a starting point. Rather than re-publish a whole new one, you can share a
**variant** — the app's "Make a variant" button pre-fills a pull request with your tweak already
attached to the original. A variant is just a preset that additionally carries:

```json
"forkedFrom": { "id": "ps_…parent…", "packId": "…", "version": "sha256:…" },
"originalAuthor": { "name": "…" },
"attribution": ["…prior authors, oldest first…"],
"changeNote": "what you changed and why",
"license": "MIT"
```

CI rejects a variant that forks a preset not in the library, drops or changes the original's
licence, credits the wrong original author, or omits the change note or attribution. A variant has
its own `id`, so it is rated, favourited and commented on in its own right, and shows up under the
original's "Variants" section once merged.

## How it is served

`packs/*.json` are the source of truth. On merge, CI validates them and builds the files `site/`
deploys to Cloudflare Pages: `index.json` (packs, for the landing page), `presets.json` (the flat
preset catalogue the app reads, with facets and the variant map) and `aliases.json`. The dynamic
parts — pack votes, and per-preset ratings, favourites, install counts and comments — come from
Pages Functions (`functions/`) backed by D1, the one piece a static site cannot do. They run on the
same origin, so there is no second service to keep in step. Every write stores a salted hash of the
voter's IP and nothing else; only the comment endpoint additionally requires a Turnstile token.

MIT licensed. Not affiliated with Blackmagic Design.
