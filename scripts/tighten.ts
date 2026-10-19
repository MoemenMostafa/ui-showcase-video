// Tighten a speech-timed showcase recording (scripts/record.ts): keep every spoken line at 1×, squeeze the silent
// stretches between lines (pointer glides, scrolls, typing, page loads) to TIGHT_GAP s, and lay the narration back on.
// On a loaded machine those stretches run 2–7 s, which reads as dead air; the voice still never talks over a screen change,
// because each line's video (caption up, screen settled) plays at normal speed under it.
//   node scripts/tighten.ts out/my-demo   → out/my-demo-tight.mp4 (+ .srt, -tight.cues.json)
// Reads <base>.mp4 (silent) and <base>.cues.json (each cue: t, caption, say, file = its voice clip, d = clip length).
// Polish (scripts/polish.ts): the end card plays at 1×, the UI sounds are re-timed, and <base>.camera.json is carried
// through the time remap into <base>-tight.camera.json (the camera itself is already in <base>.mp4).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Track } from './camera.ts';
import { speechSpan } from './narrate.ts';
import { renderSfx, SFX_MIX, sfxEvents, type SoundOptions } from './sound.ts';

type Cue = { t: number; caption: string; say: string; file: string; d: number };
const base = process.argv[2];
if (!base) throw new Error('usage: node scripts/tighten.ts <out base, e.g. out/my-demo>');
const GAP = Number(process.env.TIGHT_GAP ?? 0.3); // s of (sped-up) action between one line's end and the next caption
const LEAD = 0.1, TAIL = 0.15; // caption shows LEAD s before the voice; the line's video runs TAIL s past its last word

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const duration = (f: string) => Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).trim());
const video = `${base}.mp4`, total = duration(video);
const cues = (JSON.parse(readFileSync(`${base}.cues.json`, 'utf8')) as Cue[]).sort((a, b) => a.t - b.t);
const spans = cues.map(c => speechSpan(c.file));
const track = existsSync(`${base}.track.json`) ? (JSON.parse(readFileSync(`${base}.track.json`, 'utf8')) as Track) : undefined;
const endCard = track?.endCard ?? 0; // s of polish end card, kept at 1×

// segments of the original video: [a, b) played at 1× (a line) or squeezed into GAP s (the action between lines)
const segs: Array<{ a: number; b: number; out: number }> = [];
const newT: number[] = [];
let at = 0, now = 0;
const push = (a: number, b: number, out: number) => { if (b - a > 0.01) { segs.push({ a, b, out }); now += out; } };
const titleCard = Math.min(track?.offset ?? 0, cues[0]?.t ?? 0); // s of polish title card, kept at 1×
push(0, titleCard, titleCard);
at = titleCard;
cues.forEach((c, i) => {
  const gapEnd = c.t;
  // before the first line (page load, first scroll): up to 1 s, so the app appears without seconds of dead air
  push(at, gapEnd, Math.min(i === 0 ? 1.0 : GAP, gapEnd - at));
  newT.push(now);
  const lineEnd = Math.min(c.t + LEAD + (spans[i].to - spans[i].from) + TAIL, cues[i + 1]?.t ?? total);
  push(c.t, lineEnd, lineEnd - c.t);
  at = lineEnd;
});
push(at, total - endCard, Math.min(total - endCard - at, 1.0));
if (endCard) push(total - endCard, total, endCard);
/** A time in <base>.mp4 → the same moment in the tightened video. */
const toTight = (t: number) => { let o = 0; for (const s of segs) { if (t < s.b) return o + Math.max(0, t - s.a) * (s.out / (s.b - s.a)); o += s.out; } return o; };
/** …and back: the tightened video's time → <base>.mp4. */
const fromTight = (t: number) => { let o = 0; for (const s of segs) { if (t < o + s.out) return s.a + ((t - o) * (s.b - s.a)) / s.out; o += s.out; } return total; };

const v = segs.map((s, i) => `[0:v]trim=start=${s.a.toFixed(3)}:end=${s.b.toFixed(3)},setpts=(PTS-STARTPTS)*${(s.out / (s.b - s.a)).toFixed(5)}[v${i}]`);
const vcat = `${segs.map((_, i) => `[v${i}]`).join('')}concat=n=${segs.length}:v=1:a=0,fps=30,format=yuv420p[vid]`;
const a = cues.map((c, i) => {
  const ms = Math.round((newT[i] + LEAD) * 1000);
  return `[${i + 1}:a]atrim=start=${spans[i].from.toFixed(3)}:end=${spans[i].to.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,adelay=${ms}|${ms}[a${i}]`;
});
const voice = `${cues.map((_, i) => `[a${i}]`).join('')}amix=inputs=${cues.length}:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11`;
const out = `${base}-tight.mp4`;
// polish sound: the clicks, keys and page loads moved to their tightened times, ducked under the trimmed lines
const sound = (track?.polish as { sound?: SoundOptions } | undefined)?.sound;
const sfx = track && sound && renderSfx(sfxEvents(track).map(e => ({ ...e, t: toTight(e.t) })),
  cues.map((_, i): [number, number] => [newT[i] + LEAD, newT[i] + LEAD + spans[i].to - spans[i].from]), now, `${base}-tight.sfx.wav`, sound);
const amix = sfx ? `${voice},aresample=48000[voice];${SFX_MIX('[voice]', `[${cues.length + 1}:a]`, '[aud]')}` : `${voice},apad[aud]`;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, ...cues.flatMap(c => ['-i', c.file]), ...(sfx ? ['-i', sfx] : []),
  '-filter_complex', [...v, vcat, ...a, amix].join(';'), '-map', '[vid]', '-map', '[aud]', '-t', now.toFixed(3),
  '-c:v', 'libx264', '-crf', '20', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out], { stdio: 'inherit' });

const srtTime = (s: number) => new Date(Math.round(s * 1000)).toISOString().slice(11, 23).replace('.', ',');
writeFileSync(out.replace(/\.mp4$/, '.srt'), cues.map((c, i) => {
  const from = newT[i] + LEAD, to = Math.min(from + spans[i].to - spans[i].from, newT[i + 1] ?? now);
  return `${i + 1}\n${srtTime(from)} --> ${srtTime(to)}\n${c.say}\n`;
}).join('\n'));
writeFileSync(`${base}-tight.cues.json`, JSON.stringify(cues.map((c, i) => ({ t: newT[i], caption: c.caption, say: c.say, voice: [newT[i] + LEAD, newT[i] + LEAD + spans[i].to - spans[i].from] })), null, 2));
if (existsSync(`${base}.camera.json`)) { // the camera per tightened frame, for scripts/check.ts
  const cam = JSON.parse(readFileSync(`${base}.camera.json`, 'utf8')) as { fps: number; frames: unknown[] };
  const frames = Array.from({ length: Math.round(now * cam.fps) }, (_, j) => cam.frames[Math.min(cam.frames.length - 1, Math.round(fromTight(j / cam.fps) * cam.fps))]);
  writeFileSync(`${base}-tight.camera.json`, JSON.stringify({ ...cam, offset: toTight((cam as { offset?: number }).offset ?? 0), frames }));
}
console.log(`${out} (${now.toFixed(1)} s, from ${total.toFixed(1)} s)`);
