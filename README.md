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
node scripts/tighten.ts out/todomvc                               # speech timing: squeeze the action between lines
#   <out>-tight.mp4 (+ .srt, -tight.cues.json)  lines at 1x, gaps -> TIGHT_GAP s (default 0.3), clip padding trimmed
#   typing (<out>.typing.json) stays readable: 1x, at most TIGHT_TYPE_MAX s (default 3)
```

Tour option `"colorScheme": "dark"` records the app in dark mode (default light, regardless of the OS).

```bash
node scripts/check.ts out/todomvc-tight.mp4    # pass/warn/fail table: silent gaps, loudness, camera, blank frames
```

Voices: `NARRATOR_VOICE=af_heart` (default, US), `af_bella`, `am_michael`, `bf_emma` (UK), `bm_george` (UK).
`NARRATOR_SPEED=1.15` speeds both engines up for a brisker pace.
`NARRATOR_ENGINE=say` uses macOS voices instead (`NARRATOR_VOICE=Samantha`, `NARRATOR_RATE=185`).

## Tour steps

| Step | Does |
|---|---|
| `{ "goto": "/#path", "waitFor": "css" }` | open a page, wait for an element. The URL is `new URL(goto, base)`, so keep `base` a bare host (`https://host`) and put any path in `goto` |
| `{ "caption": "On screen", "say": "Spoken line", "focus": "css" }` | scroll `focus` to the middle and mark it (frame + dimmed page, until the next focus), then show the caption and start the line; `"focus": null` clears the mark |
| `{ "focus": "css" }` | move the mark without a caption |
| `{ "waitForVoice": true }` or `{ "waitForVoice": 1500 }` | `"timing": "flow"` only: hold the next steps until the current line ends, or that many ms before it ends (e.g. before a click that would change what the line describes) |
| `{ "pause": 5000, "hold": true }` | hold, in ms. With the default `"timing": "speech"` (captions last as long as their spoken line) plain pauses are skipped and only `hold` ones count; with `"timing": "pauses"` every pause counts |
| `{ "click": "css", "last": true, "optional": true }` | glide, ripple, click; `optional` skips a missing target |
| `{ "type": "css", "text": "…" }` | click and type visibly, key by key |
| `{ "fill": "css", "text": "" }` | set a value without showing typing |
| `{ "hover": "css" }` | glide the pointer there without clicking (it is hidden until its first move) |
| `{ "press": "Escape" }` | a key |
| `{ "clickUntil": "css", "attr": ["html", "data-theme"], "equals": "dark" }` | click until an attribute has a value (cycling toggles) |

`{{name}}` in the tour is replaced by `--var name=value`.

### Timing modes (`"timing"` in the tour)

- `"speech"` (default): each line is spoken, then the next steps run; captions last exactly as long as their line.
  The only mode where the voice never runs ahead of or behind the screen. Put each caption after the step that reveals
  what it describes, then run `scripts/tighten.ts` to remove the dead air between lines (on a busy machine 2–7 s).
- `"flow"`: continuous narration. A line doesn't block: the steps after it (clicks, typing, page loads) run while it is
  spoken, and the next caption only waits for the voice. Place each line just before the action it describes, and use
  `waitForVoice` before a click that would change the screen too early. Check gaps with
  `ffmpeg -i <narrated.mp4> -af silencedetect=noise=-40dB:d=0.7 -vn -f null -`.
- `"pauses"`: hand-set `pause` steps set the timing; lines are fitted to them afterwards.

**Intro card:** a caption placed before the first `goto` is shown as a full-screen title card (`"Title · subtitle"`).
It stays over the page while the app loads, so a spoken introduction can cover the start-up time.

The overlay (pointer, caption, mark, title) lives in the browser's top layer, so it also covers modal `<dialog>`s.

## Polish (optional)

All off by default: a tour without `"polish"` records exactly as before. Turn features on in the tour:

```json
"polish": {
  "camera": true,
  "sound": true,
  "frame": { "address": "app.example.com" },
  "cards": { "title": "Acme Board", "subtitle": "A short tour", "brand": "#3b82f6", "logo": "logo.svg", "end": "Thanks for watching" },
  "blur": true
}
```

`true` uses the defaults below; a missing key or `false` means off. `--polish camera,sound` on the command line turns
on exactly those features (keeping the tour's options for them); `--polish none` turns all off.

| Feature | Does | Options (default) |
|---|---|---|
| `camera` | Virtual camera: zooms in on each `focus` area (with padding), follows the pointer gently when nothing is marked, zooms out to the full view on page loads. Moves only between lines, eased in ahead of the action, and holds still while a line is spoken; never crops the focus area or the pointer. Records at 2× pixels, so zoomed text stays sharp; output 1080p at the viewport's aspect. Captions are drawn over the output, not zoomed. Before each line the recorder waits `lead + smoothness` after the focus moves, so the move fits in. | `maxZoom` (1.8), `padding` CSS px around the focus (40), `lead` s the move ends before the action (0.15), `smoothness` s per move (0.7), `idleZoom` with no focus (1.2), `wideFocus` height / fit (height: a focus area more than 1.5× wider than the view's aspect is framed on its height, around the pointer, instead of on its full width at ~1× zoom). Views close to the page edge move flush with it (no thin sliver). Per step: `"camera": false` shows the full view while that step runs. |
| `sound` | Soft click per click, light ticks while typing, a gentle whoosh on page loads; synthesised offline, one shared small-room reverb, ducked under the voice; final mix ≈ -16 LUFS, limited. | `volume` dB (0), `duck` dB under speech (7) |
| `frame` | The recording in a rounded browser window with a soft shadow on a background; 1920×1080 output; composites with the camera (it zooms inside the window). | `background` colour list → diagonal gradient, or any CSS background (`["#e9edf5", "#c3cde2"]`), `radius` px (14), `padding` px (56), `address` bar text (empty: no real URL leaks), `theme` light/dark (the tour's `colorScheme`) |
| `cards` | Branded title card before, optional end card after the recording, cross-fading in and out. An intro caption's card (before the first `goto`) uses the same background and text colour. | `title`, `subtitle`, `duration` s (2.5); `end`: `"text"` or `{ title, subtitle, duration (3) }`; `brand` accent colour (#ff6b1a); `background` (brand-tinted dark gradient); `color` text (#fff); `logo` image path, relative to the tour; `animation` fade / scale / none (fade) |
| `captions` | Not a feature: options for the captions, which `camera` or `frame` draw over the output (not in the page, where they'd be zoomed or scaled). | `size` text px at 1080p (36), `position` auto / bottom / top (auto: bottom, or top when the bottom box would cover the focus or pointer) |
| `blur` | Light motion blur while the camera moves fast (sub-samples along the camera path, scaled to its speed); none on still holds, never on captions. Needs `camera`. | `strength` (1) |

With polish, record writes `<out>.raw.mp4` (sharp intermediate), `<out>.track.json` (pointer, focus, clicks, keys,
lines, page loads per moment) and `<out>.camera.json` (the camera per frame, for `check.ts`), then renders `<out>.mp4`
from them; `node scripts/polish.ts <out>` re-renders it after changing options (then re-run `narrate.ts` and
`tighten.ts`). `tighten.ts` keeps the end card at 1×, re-times the sounds and writes `<out>-tight.camera.json`.
Rendering takes about 2–3× the video's length. Cue times in `.cues.json` include the title card.
