// Check a showcase video before handing it over: prints a pass/warn/fail table, exits 1 on any fail.
//   node scripts/check.ts <video.mp4> [cues.json]
// - silent gaps: ≥ 0.7 s below -40 dB between the first and the last sound (a title card before the first line and the
//   fade after the last one don't count); warn on any, fail on one over 2 s. Check the -tight file of a speech-timed tour.
// - loudness: integrated level near -16 LUFS.
// - camera (polish): share of frames where the camera moves (warn over 70%), and the focus area and pointer inside the
//   view on every frame. Reads <base>.camera.json, or <base>-tight.camera.json for a -tight video.
// - lead-in: time from the start (or the end of the polish title card) to the first line; warn over 1.5 s of it.
// - blank frames: flat (white, black, one colour) frames in the recording area (not on polish cards), every frame;
//   fail on a run of 1 s or more, warn on shorter ones.
// - flashes: the whole picture jumps much brighter (or darker) than on both sides and back within 1 s, e.g. a white page
//   between two dark ones, or a fade through white; warn on any.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

type Rect = [number, number, number, number];
interface Camera { fps: number; content: Rect; viewport: [number, number]; camera: boolean; frames: Array<{ v: Rect; f?: Rect | null; p?: [number, number] | null; w?: boolean } | null> }
type Row = [string, 'PASS' | 'WARN' | 'FAIL' | 'SKIP', string];

const [video, cuesArg] = process.argv.slice(2);
if (!video) { console.error('usage: node scripts/check.ts <video.mp4> [cues.json]'); process.exit(1); }
const base = video.replace(/(-narrated)?\.mp4$/, '');
const ffmpeg = (args: string[]) => spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
const probe = (entries: string) => spawnSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', video], { encoding: 'utf8' }).stdout.trim();
const duration = Number(probe('format=duration'));
const hasAudio = probe('stream=codec_type').includes('audio');
const cuesFile = cuesArg ?? [`${base}.cues.json`].find(f => existsSync(f));
const cues = cuesFile ? (JSON.parse(readFileSync(cuesFile, 'utf8')) as Array<{ t: number; voice?: [number, number] }>) : [];
const camFile = `${base}.camera.json`;
const cam = existsSync(camFile) ? (JSON.parse(readFileSync(camFile, 'utf8')) as Camera & { offset?: number }) : undefined;
const s1 = (v: number) => v.toFixed(1);
const rows: Row[] = [];

// silent gaps
if (!hasAudio) rows.push(['silent gaps', 'SKIP', 'no audio track (check the -narrated or -tight file)']);
else {
  const log = ffmpeg(['-i', video, '-af', 'silencedetect=noise=-40dB:d=0.7', '-vn', '-f', 'null', '-']).stderr;
  const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map(m => Number(m[1]));
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map(m => Number(m[1]));
  // before the first line (page load, title card) and after the last one don't count
  const first = cues.length ? Math.min(...cues.map(c => c.t)) : 0;
  const gaps = starts.map((s, i) => ({ s, e: ends[i] ?? duration })).filter(g => g.s > 0.05 && g.e > first + 0.3 && g.e < duration - 0.05);
  const after = (t: number) => { const k = cues.filter(c => c.t <= t).length; return k ? ` after line ${k}` : ''; };
  const longest = Math.max(0, ...gaps.map(g => g.e - g.s));
  rows.push(['silent gaps', !gaps.length ? 'PASS' : longest > 2 ? 'FAIL' : 'WARN',
    !gaps.length ? `none ≥ 0.7 s${first > 2 ? ` (first line at ${s1(first)} s)` : ''}` : gaps.slice(0, 4).map(g => `${s1(g.e - g.s)} s at ${s1(g.s)} s${after(g.s)}`).join('; ') + (gaps.length > 4 ? ` (+${gaps.length - 4} more)` : '')]);
  const lufs = Number([...ffmpeg(['-i', video, '-af', 'ebur128', '-vn', '-f', 'null', '-']).stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop()?.[1]);
  rows.push(['loudness', lufs >= -18 && lufs <= -14 ? 'PASS' : 'WARN', `${s1(lufs)} LUFS (aim for -16)`]);
}

// lead-in: silence between the title card (polish) or the start and the first line
if (!cues.length) rows.push(['lead-in', 'SKIP', 'no cues']);
else {
  const card = cam?.offset ?? 0, first = Math.min(...cues.map(c => c.voice?.[0] ?? c.t)), lead = first - card;
  rows.push(['lead-in', lead > 1.5 ? 'WARN' : 'PASS', `first line at ${s1(first)} s, ${s1(Math.max(0, lead))} s after ${card ? 'the title card' : 'the start'}`]);
}

// camera: moving vs still, and nothing that matters cut off
const shots = cam?.camera ? cam.frames.filter((f): f is NonNullable<typeof f> => !!f) : [];
if (!shots.length) rows.push(['camera motion', 'SKIP', 'no camera track']);
else {
  const scale = cam!.content[2] / cam!.viewport[0];
  const moved = shots.filter((f, i) => i > 0 && Math.max(...f.v.map((x, c) => Math.abs(x - shots[i - 1].v[c]))) * (cam!.viewport[0] / (f.v[2] - f.v[0])) * scale > 0.25).length;
  const share = moved / shots.length;
  rows.push(['camera motion', share > 0.7 ? 'WARN' : 'PASS', `moving ${Math.round(share * 100)}% / still ${Math.round((1 - share) * 100)}% of ${shots.length} frames`]);
  const [W, H] = cam!.viewport, within = (r: Rect, v: Rect) => r[0] >= v[0] - 1 && r[1] >= v[1] - 1 && r[2] <= v[2] + 1 && r[3] <= v[3] + 1;
  const clip = (r: Rect): Rect | null => { const c: Rect = [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(W, r[2]), Math.min(H, r[3])]; return c[2] - c[0] < 1 || c[3] - c[1] < 1 ? null : c; };
  let focusN = 0, focusBad = 0, ptrN = 0, ptrBad = 0;
  const bad: number[] = [];
  cam!.frames.forEach((f, i) => {
    if (!f || f.w) return; // cards and page loads show the full view
    const fr = f.f && clip(f.f);
    if (fr) { focusN++; if (!within(fr, f.v)) { focusBad++; bad.push(i); } }
    const pr = f.p && clip([f.p[0] - 1, f.p[1] - 1, f.p[0] + 20, f.p[1] + 20]); // the arrow
    if (pr) { ptrN++; if (!within(pr, f.v)) { ptrBad++; bad.push(i); } }
  });
  rows.push(['focus in frame', focusBad || ptrBad ? 'FAIL' : 'PASS',
    `focus inside on ${focusN - focusBad}/${focusN} frames, pointer on ${ptrN - ptrBad}/${ptrN}` + (bad.length ? `; first miss at ${s1(bad[0] / cam!.fps)} s` : '')]);
}

// blank frames: nearly one flat level across the recording area, on every frame (a flash can be 2 frames long)
const fps = cam?.fps ?? 30;
const [cx, cy, cw, ch] = cam?.content ?? [0, 0, 0, 0];
const crop = cam ? `crop=${cw}:${ch}:${cx}:${cy},` : '';
const levels = (vf: string) => ffmpeg(['-i', video, '-vf', `fps=${fps},${vf}scale=480:-2,signalstats,metadata=print:file=-`, '-an', '-f', 'null', '-']).stdout
  .split(/(?=frame:)/).map(block => {
    const v = (k: string) => Number(new RegExp(`signalstats\\.${k}=([\\d.]+)`).exec(block)?.[1]);
    return { t: Number(/pts_time:([\d.]+)/.exec(block)?.[1]), avg: v('YAVG'), flat: v('YHIGH') - v('YLOW') <= 2 && v('YMAX') - v('YMIN') <= 12 };
  }).filter(f => Number.isFinite(f.t) && Number.isFinite(f.avg));
const flat: Array<{ t: number; white: boolean }> = [];
for (const f of levels(crop)) {
  const onCard = cam && !cam.frames[Math.min(cam.frames.length - 1, Math.round(f.t * cam.fps))]; // title/end card: fades are meant
  if (!onCard && f.flat) flat.push({ t: f.t, white: f.avg > 200 });
}
let run = 0, longestRun = 0;
flat.forEach((f, i) => { run = i && f.t - flat[i - 1].t < 1.5 / fps ? run + 1 / fps : 1 / fps; longestRun = Math.max(longestRun, run); });
rows.push(['blank frames', !flat.length ? 'PASS' : longestRun >= 1 ? 'FAIL' : 'WARN',
  !flat.length ? 'none' : `${flat.length} of ${Math.round(duration * fps)} frames flat (${flat.filter(f => f.white).length} white), longest ${s1(longestRun)} s, first at ${s1(flat[0].t)} s`]);

// flashes: a frame far brighter (or darker) than the darkest (brightest) frame within 1 s on BOTH sides — a spike that
// comes back, not a cut to a new scene; on the whole picture, cards included (a card can fade through white)
const y = levels('').map(f => f.avg), win = Math.round(fps), JUMP = 50;
const odd: Array<{ i: number; white: boolean }> = [];
for (let i = win; i < y.length - win; i++) {
  const before = y.slice(i - win, i), after = y.slice(i + 1, i + 1 + win);
  if (y[i] - Math.max(Math.min(...before), Math.min(...after)) > JUMP) odd.push({ i, white: true });
  else if (Math.min(Math.max(...before), Math.max(...after)) - y[i] > JUMP) odd.push({ i, white: false });
}
const flashes: Array<{ from: number; to: number; white: boolean }> = [];
for (const o of odd) {
  const last = flashes[flashes.length - 1];
  if (last && o.i - last.to <= 2 && o.white === last.white) last.to = o.i; else flashes.push({ from: o.i, to: o.i, white: o.white });
}
rows.push(['flashes', flashes.length ? 'WARN' : 'PASS', !flashes.length ? 'none under 1 s' : flashes.slice(0, 4)
  .map(f => `${s1((f.to - f.from + 1) / fps)} s ${f.white ? 'bright' : 'dark'} at ${s1(f.from / fps)} s`).join('; ') + (flashes.length > 4 ? ` (+${flashes.length - 4} more)` : '')]);

console.log(`${video} (${s1(duration)} s)`);
const w = Math.max(...rows.map(r => r[0].length));
for (const [name, res, detail] of rows) console.log(`${name.padEnd(w)}  ${res.padEnd(4)}  ${detail}`);
if (rows.some(r => r[1] === 'FAIL')) process.exit(1);
