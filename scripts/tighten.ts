// Tighten a speech-timed showcase recording (scripts/record.ts): keep every spoken line at 1×, squeeze the silent
// stretches between lines (pointer glides, scrolls, typing, page loads) to TIGHT_GAP s, and lay the narration back on.
// On a loaded machine those stretches run 2–7 s, which reads as dead air; the voice still never talks over a screen change,
// because each line's video (caption up, screen settled) plays at normal speed under it.
//   node scripts/tighten.ts out/my-demo   → out/my-demo-tight.mp4 (+ .srt, -tight.cues.json)
// Reads <base>.mp4 (silent) and <base>.cues.json (each cue: t, caption, say, file = its voice clip, d = clip length).
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

type Cue = { t: number; caption: string; say: string; file: string; d: number };
const base = process.argv[2];
if (!base) throw new Error('usage: node scripts/tighten.ts <out base, e.g. out/my-demo>');
const GAP = Number(process.env.TIGHT_GAP ?? 0.3); // s of (sped-up) action between one line's end and the next caption
const LEAD = 0.1, TAIL = 0.15; // caption shows LEAD s before the voice; the line's video runs TAIL s past its last word

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const duration = (f: string) => Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).trim());
/** Where the speech in a clip starts and ends (Kokoro pads ~0.3 s before and ~0.5 s after). */
function speechSpan(file: string): { from: number; to: number } {
  const d = duration(file);
  // ffmpeg prints the silencedetect lines on stderr
  const log = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'silencedetect=noise=-40dB:d=0.05', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map(m => Number(m[1]));
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map(m => Number(m[1]));
  const from = starts[0] !== undefined && starts[0] < 0.01 && ends[0] !== undefined ? ends[0] : 0;
  const lastStart = starts[starts.length - 1];
  // a trailing silence either has no end or ends at the end of the clip
  const trailing = lastStart !== undefined && lastStart > from && (ends.length < starts.length || ends[ends.length - 1] >= d - 0.02);
  const to = trailing ? lastStart : d;
  return { from: Math.max(0, from - 0.03), to: Math.min(d, to + 0.05) };
}

const video = `${base}.mp4`, total = duration(video);
const cues = (JSON.parse(readFileSync(`${base}.cues.json`, 'utf8')) as Cue[]).sort((a, b) => a.t - b.t);
const spans = cues.map(c => speechSpan(c.file));

// segments of the original video: [a, b) played at 1× (a line) or squeezed into GAP s (the action between lines)
const segs: Array<{ a: number; b: number; out: number }> = [];
const newT: number[] = [];
let at = 0, now = 0;
const push = (a: number, b: number, out: number) => { if (b - a > 0.01) { segs.push({ a, b, out }); now += out; } };
cues.forEach((c, i) => {
  const gapEnd = c.t;
  // before the first line (page load, first scroll): up to 1 s, so the app appears without seconds of dead air
  push(at, gapEnd, Math.min(i === 0 ? 1.0 : GAP, gapEnd - at));
  newT.push(now);
  const lineEnd = Math.min(c.t + LEAD + (spans[i].to - spans[i].from) + TAIL, cues[i + 1]?.t ?? total);
  push(c.t, lineEnd, lineEnd - c.t);
  at = lineEnd;
});
push(at, total, Math.min(total - at, 1.0));

const v = segs.map((s, i) => `[0:v]trim=start=${s.a.toFixed(3)}:end=${s.b.toFixed(3)},setpts=(PTS-STARTPTS)*${(s.out / (s.b - s.a)).toFixed(5)}[v${i}]`);
const vcat = `${segs.map((_, i) => `[v${i}]`).join('')}concat=n=${segs.length}:v=1:a=0,fps=30,format=yuv420p[vid]`;
const a = cues.map((c, i) => {
  const ms = Math.round((newT[i] + LEAD) * 1000);
  return `[${i + 1}:a]atrim=start=${spans[i].from.toFixed(3)}:end=${spans[i].to.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,adelay=${ms}|${ms}[a${i}]`;
});
const amix = `${cues.map((_, i) => `[a${i}]`).join('')}amix=inputs=${cues.length}:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,apad[aud]`;
const out = `${base}-tight.mp4`;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, ...cues.flatMap(c => ['-i', c.file]),
  '-filter_complex', [...v, vcat, ...a, amix].join(';'), '-map', '[vid]', '-map', '[aud]', '-t', now.toFixed(3),
  '-c:v', 'libx264', '-crf', '20', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out], { stdio: 'inherit' });

const srtTime = (s: number) => new Date(Math.round(s * 1000)).toISOString().slice(11, 23).replace('.', ',');
writeFileSync(out.replace(/\.mp4$/, '.srt'), cues.map((c, i) => {
  const from = newT[i] + LEAD, to = Math.min(from + spans[i].to - spans[i].from, newT[i + 1] ?? now);
  return `${i + 1}\n${srtTime(from)} --> ${srtTime(to)}\n${c.say}\n`;
}).join('\n'));
writeFileSync(`${base}-tight.cues.json`, JSON.stringify(cues.map((c, i) => ({ t: newT[i], caption: c.caption, say: c.say, voice: [newT[i] + LEAD, newT[i] + LEAD + spans[i].to - spans[i].from] })), null, 2));
console.log(`${out} (${now.toFixed(1)} s, from ${total.toFixed(1)} s)`);
