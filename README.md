# ui-showcase-video

Record a narrated showcase video of any web UI, offline:

- a **drawn pointer** that glides to each target and a **ripple** where it clicks (headless browser video has no cursor);
- **captions** on screen, and a **spotlight** on the area being talked about, scrolled to the middle of the screen;
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
node scripts/record.ts examples/todomvc.tour.json
# prints the paths it writes, next to the tour's `out` (relative to the tour file):
#   <out>.mp4             the silent recording
#   <out>.cues.json       when each caption appeared + its spoken line
#   <out>-narrated.mp4    the finished video, + <out>-narrated.srt subtitles

node scripts/narrate.ts out/todomvc.mp4 out/todomvc.cues.json    # re-voice only
```

Voices: `NARRATOR_VOICE=af_heart` (default, US), `af_bella`, `am_michael`, `bf_emma` (UK), `bm_george` (UK).
`NARRATOR_SPEED=1.15` speeds both engines up for a brisker pace.
`NARRATOR_ENGINE=say` uses macOS voices instead (`NARRATOR_VOICE=Samantha`, `NARRATOR_RATE=185`).

## Tour steps

| Step | Does |
|---|---|
| `{ "goto": "/#path", "waitFor": "css" }` | open a page (relative to `base`), wait for an element |
| `{ "caption": "On screen", "say": "Spoken line", "focus": "css" }` | scroll `focus` to the middle and mark it (frame + dimmed page, until the next focus), then show the caption and start the line; `"focus": null` clears the mark |
| `{ "focus": "css" }` | move the mark without a caption |
| `{ "pause": 5000, "hold": true }` | hold, in ms. With the default `"timing": "speech"` (captions last as long as their spoken line) plain pauses are skipped and only `hold` ones count; with `"timing": "pauses"` every pause counts |
| `{ "click": "css", "last": true, "optional": true }` | glide, ripple, click; `optional` skips a missing target |
| `{ "type": "css", "text": "…" }` | click and type visibly, key by key |
| `{ "fill": "css", "text": "" }` | set a value without showing typing |
| `{ "hover": "css" }` | glide the pointer there without clicking (it is hidden until its first move) |
| `{ "press": "Escape" }` | a key |
| `{ "clickUntil": "css", "attr": ["html", "data-theme"], "equals": "dark" }` | click until an attribute has a value (cycling toggles) |

`{{name}}` in the tour is replaced by `--var name=value`.
