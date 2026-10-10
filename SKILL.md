---
name: recording-ui-showcase-videos
description: Use when asked for a demo, showcase, walkthrough or screen-recording video of a web app or local dashboard, especially with voice-over/narration, captions, subtitles, or visible clicks
---

# Recording UI showcase videos

## Overview
A tour file (JSON steps) drives Chrome; a drawn pointer glides to each target and ripples on click; captions are timed; Kokoro (offline neural TTS) speaks each line at its caption; you get an MP4 + `.srt`. The tool lives in this skill's folder — use it instead of hand-rolling a recorder.

## Steps
1. **Setup once** (in this folder): `npm install`. Behind a TLS proxy prefix `NODE_EXTRA_CA_CERTS=<proxy CA.pem>` (also for the first narration: the ~90 MB model downloads then). Needs Node ≥ 22.18, ffmpeg, Google Chrome.
2. **Write the tour** next to the user's project (`<name>.tour.json`; step reference in `README.md`, example in `examples/`). `out` is relative to the tour file. Give every caption a `focus` (CSS of the area it talks about): the recorder scrolls it to the middle — page or inner scroll box — and marks it before the line starts; `null` clears it. `focus` must be plain CSS (looked up again each frame, so live re-rendering keeps the mark; no Playwright-only `text=`). Start with a `hover` on the first thing you talk about (the pointer stays hidden until it first moves). Read-only: never click buttons that start, delete, submit or pay.
3. **Timing is by speech (default):** every line is spoken first, each caption holds exactly as long as its line, and plain `pause` steps are skipped — no silent gaps. Use `{ "pause": ms, "hold": true }` only to linger on purpose (e.g. a live screen). `"timing": "pauses"` in the tour switches back to hand-set pauses, where you **budget time per line:** Kokoro speaks ~2.6 words/s (× `NARRATOR_SPEED`). After each `caption` step, the steps until the next caption must last ≥ words ÷ 2.6 + 0.5 s. Total length ≈ sum of pauses + 0.8 s per click/hover + ~3 s fixed (page load, last line's tail) — check it against the requested duration *before* recording.
4. **Record:** `node scripts/record.ts <tour.json> [--var name=value]` → `<out>.mp4`, `<out>.cues.json`, `<out>-narrated.mp4`, `.srt`. Re-voice only: `node scripts/narrate.ts <out>.mp4 <out>.cues.json`.
5. **Verify before handing over:**
   - narrator printed no `cue N … needs X s` warning (else shorten that line or lengthen its pause, re-run narrate);
   - `ffmpeg -i <narrated.mp4> -af volumedetect -vn -f null -` → mean volume about −16…−22 dB (not silent);
   - extract a frame ~1 s after each cue `t` (`ffmpeg -ss <t+1> -i … -frames:v 1 x.png`) and look at it: right screen, caption shown, pointer on target.

## Quick reference
| Need | Do |
|---|---|
| Other voice | `NARRATOR_VOICE=bf_emma` (UK) / `am_michael` / `af_bella`; default `af_heart` |
| Brisker pace | `NARRATOR_SPEED=1.15` (both engines); budget words ÷ (2.6 × speed) |
| No Kokoro / quick draft | `NARRATOR_ENGINE=say` (macOS voices; robotic) |
| Dynamic URL part | `"/#run/{{runId}}"` + `--var runId=…` |
| Cycle a toggle to a state | `clickUntil` with `attr` + `equals` |
| Target may be absent | `"optional": true` on `click` |
| Area below the fold | just `focus` (or click) it — scrolled to the middle automatically |

## Common mistakes
| Symptom | Cause / fix |
|---|---|
| "Executable doesn't exist … playwright install ffmpeg" | Using Playwright `recordVideo`. This tool records via Chrome screencast + system ffmpeg instead — don't switch back. |
| x264 "width not divisible by 2" | Odd frame size; the encoder here pads to even. Only matters if hand-encoding. |
| No cursor in the video | Headless video has none; the drawn pointer only moves on tour `click`/`type` steps. |
| Zoomed image/modal shows blank | An element with `display:block` CSS beats `[hidden]`; add `[hidden]{display:none}` in the app. |
| Narration overlaps / rushed | Lines longer than their pause; fix the budget (step 3), not the speed. |
| Video longer than asked | Too many words. Cut lines; captions can stay longer than speech. |
