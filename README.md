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

- Levels, EQ bands and dynamics as the switcher stores them: integers, dB and Q scaled ×100,
  frequency in Hz.
- The switcher model and firmware build a preset came from, so people can judge whether it suits
  their hardware.
- **Never** a channel's on/off state — that is a live operating control, and pasting one would
  mute someone mid-show. Packs containing it are rejected.
- Nothing identifying: no addresses, no serial numbers, no unique ids.

## How it is served

`packs/*.json` are the source of truth. On merge, CI validates them, builds `site/index.json`,
and deploys `site/` to Cloudflare Pages. Vote counts come from a small Worker (`worker/`) backed
by D1 — the one piece a static site cannot do. It stores a salted hash of the voter's IP and
nothing else.

MIT licensed. Not affiliated with Blackmagic Design.
