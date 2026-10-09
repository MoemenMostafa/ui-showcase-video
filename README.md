# ui-showcase-video

Record a narrated showcase video of any web UI, offline:

- a **drawn pointer** that glides to each target and a **ripple** where it clicks (headless browser video has no cursor);
- **captions** on screen;
- a **natural spoken narration** with [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) (82M-parameter neural TTS, runs locally on CPU), or macOS `say`;
- **subtitles** (`.srt`) and an MP4 ready to share.

The tour is a JSON file of steps, so a new video needs no code. It is also a Claude Code skill
(`SKILL.md`): link this folder as `~/.claude/skills/recording-ui-showcase-videos` and ask Claude for a demo video.

## Setup

```bash
npm install                    # playwright-core + kokoro-js (behind a TLS proxy: NODE_EXTRA_CA_CERTS=<proxy CA>)
```

Needs Node ≥ 22.18 (runs `.ts` directly), ffmpeg, and an installed Google Chrome (no browser download).
The Kokoro model (~90 MB) downloads from Hugging Face on first use and is cached in `node_modules`.

## Use

```bash
node scripts/record.ts examples/runner-ui.tour.json --var runId=20261009-162346-5gui
# → out/runner-ui.webm, out/runner-ui.cues.json, out/runner-ui-narrated.mp4 (+ .srt)

node scripts/narrate.ts out/runner-ui.webm out/runner-ui.cues.json   # re-voice only
```

Voices: `NARRATOR_VOICE=af_heart` (default, US), `af_bella`, `am_michael`, `bf_emma` (UK), `bm_george` (UK).
`NARRATOR_ENGINE=say` uses macOS voices instead (`NARRATOR_VOICE=Samantha`, `NARRATOR_RATE=185`).

## Tour steps

| Step | Does |
|---|---|
| `{ "goto": "/#path", "waitFor": "css" }` | open a page (relative to `base`), wait for an element |
| `{ "caption": "On screen", "say": "Spoken line" }` | show a caption and note when the narrator speaks |
| `{ "pause": 5000 }` | hold, in ms — give each spoken line enough time |
| `{ "click": "css", "last": true, "optional": true }` | glide, ripple, click; `optional` skips a missing target |
| `{ "type": "css", "text": "…" }` | click and type visibly, key by key |
| `{ "fill": "css", "text": "" }` | set a value without showing typing |
| `{ "press": "Escape" }` | a key |
| `{ "clickUntil": "css", "attr": ["html", "data-theme"], "equals": "dark" }` | click until an attribute has a value (cycling toggles) |

`{{name}}` in the tour is replaced by `--var name=value`.
