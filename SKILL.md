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
3. **Timing is by speech (default) — use it whenever narration must match the screen exactly:** every line is spoken first, each caption holds exactly as long as its line, and plain `pause` steps are skipped — no silent gaps. Use `{ "pause": ms, "hold": true }` only to linger on purpose (e.g. a live screen). For **continuous narration with no gaps**, use `"timing": "flow"`: steps after a line run while it is spoken; put each line just before the action it describes, open with an intro caption *before* the first `goto` (shown as a title card while the app loads), and add `{ "waitForVoice": ms }` before clicks that would change the screen too early. Flow mode drifts: the screen moves on while a line is still being spoken, so viewers hear one thing and see the next — avoid it when sync matters. Write each line *after* the step that reveals what it describes (click, then caption), never before, and keep live numbers out of the spoken text (counts change; say them only if they're fixed facts). `"timing": "pauses"` in the tour switches back to hand-set pauses, where you **budget time per line:** Kokoro speaks ~2.6 words/s (× `NARRATOR_SPEED`). After each `caption` step, the steps until the next caption must last ≥ words ÷ 2.6 + 0.5 s. Total length ≈ sum of pauses + 0.8 s per click/hover + ~3 s fixed (page load, last line's tail) — check it against the requested duration *before* recording.
4. **Record:** `node scripts/record.ts <tour.json> [--var name=value]` → `<out>.mp4`, `<out>.cues.json`, `<out>-narrated.mp4`, `.srt`. Re-voice only: `node scripts/narrate.ts <out>.mp4 <out>.cues.json`. Set `"colorScheme": "dark"` in the tour if the app should be shown in dark mode (the default is light, whatever the OS uses).
4b. **Tighten (speech timing):** `node scripts/tighten.ts <out>` → `<out>-tight.mp4` + `.srt` + `-tight.cues.json`. Every spoken stretch stays at 1×; the action between lines (pointer glides, scrolls, typing, page loads) is squeezed into `TIGHT_GAP` s (default 0.3), and the ~0.3 s / 0.5 s of silence Kokoro pads around each clip is trimmed. Needed on a busy machine, where the gaps between lines stretch to 2–7 s of dead air — and in general, because that clip padding alone makes every gap ≥ 0.8 s, so the silence check below can never pass on the untightened file. Screen changes then show as quick ~0.3 s jumps; the voice still never overlaps one. Hand over the `-tight` file, not `-narrated`.
5. **Verify before handing over:**
   - `ffmpeg -i <final.mp4> -af silencedetect=noise=-40dB:d=0.7 -vn -f null -` lists no long gaps (speech timing: check the `-tight` file; only the fade after the last line may exceed it);
   - narrator printed no `cue N … needs X s` warning (else shorten that line or lengthen its pause, re-run narrate);
   - `ffmpeg -i <narrated.mp4> -af volumedetect -vn -f null -` → mean volume about −16…−22 dB (not silent);
   - `node scripts/check.ts <final.mp4>` prints these checks plus camera motion, focus-in-frame and blank frames as a pass/warn/fail table;
   - for EVERY cue extract two frames — ~1 s after its `t` and just before its line ends (`ffmpeg -ss <t> -i … -frames:v 1 x.png`; use the `-tight.cues.json` times for a tightened file) — and look at both: caption matches what's on screen, focus mark and pointer on the thing described, and the screen did not change between the two. Report a cue table (t, caption, what the frame shows, OK) and re-record until every row is OK; sampling a few cues misses drift.

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
| Zoom in on what's talked about | `"polish": { "camera": true }` (`maxZoom` 1.8, `padding` 40, `lead` 0.15, `smoothness` 0.7, `idleZoom` 1.2; `"camera": false` on a step = full view) |
| UI sounds under the voice | `"polish": { "sound": true }` (`volume` 0 dB, `duck` 7 dB) |
| Browser-window look | `"polish": { "frame": true }` (`background`, `radius` 14, `padding` 56, `address` "" — never a real URL) |
| Branded title / end card | `"polish": { "cards": { "title", "subtitle", "brand", "logo", "end" } }` (title 2.5 s, end 3 s, `animation` fade) |
| Motion blur on fast moves | `"polish": { "blur": true }` (needs camera) |
| Polish without editing the tour | `--polish camera,sound` (exactly these; `none` = off). All options: README |

## Common mistakes
| Symptom | Cause / fix |
|---|---|
| "Executable doesn't exist … playwright install ffmpeg" | Using Playwright `recordVideo`. This tool records via Chrome screencast + system ffmpeg instead — don't switch back. |
| x264 "width not divisible by 2" | Odd frame size; the encoder here pads to even. Only matters if hand-encoding. |
| No cursor in the video | Headless video has none; the drawn pointer only moves on tour `click`/`type` steps. |
| Spoken text misreads names | Spell the `say` text the way it should sound (e.g. `S Q L` to spell out an acronym, `engine x` for nginx); captions keep the normal spelling. |
| Zoomed image/modal shows blank | An element with `display:block` CSS beats `[hidden]`; add `[hidden]{display:none}` in the app. |
| Narration overlaps / rushed | Lines longer than their pause; fix the budget (step 3), not the speed. |
| Voice describes the next screen, or the screen changes mid-line | Flow timing, or the caption sits before the click that reveals its content. Use speech timing; put the caption after the click. |
| 2–7 s of dead air between lines | Busy machine (pointer, scroll, page loads slowed). Run `scripts/tighten.ts`; don't speed up the voice. |
| Silence check fails even with no pauses | Kokoro pads each clip (~0.8 s together). Check the `-tight` output instead. |
| Spoken count is wrong a day later | Live numbers in the narration. Say only fixed facts; let the screen show the counts. |
| Video longer than asked | Too many words. Cut lines; captions can stay longer than speech. |
| Camera drifts or crops | Give every caption a `focus`; re-render with other options via `node scripts/polish.ts <out>` (no re-recording). |
