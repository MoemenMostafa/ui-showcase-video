// Add a spoken narration and subtitles to a video. Three engines:
//   - Kokoro (kokoro-js, an 82M-parameter neural voice: natural, offline, English-first), the default;
//   - macOS `say` with NARRATOR_ENGINE=say (or when kokoro-js is not installed), offline;
//   - Edge-TTS with NARRATOR_ENGINE=edge (msedge-tts: neural, multilingual, needs the network), default voice ar-EG-SalmaNeural.
//   node scripts/narrate.ts <video.webm|mp4> <cues.json>   → <video>-narrated.mp4 + .srt
// cues.json: [{ "t": seconds, "say": "spoken text", "file"?: pre-made clip }, …] — record.ts writes it;
// in speech-timed recordings the clips already exist (record.ts made them first) and are reused as they are.
// NARRATOR_VOICE (af_heart for Kokoro, Samantha for say, ar-EG-SalmaNeural for edge — e.g. en-US-AriaNeural),
// NARRATOR_RATE (say only, words per minute, 185), NARRATOR_SPEED (1.0; e.g. 1.15 for a brisker pace — all engines).
// Polish "sound" (scripts/sound.ts): the UI sounds in <base>.track.json are mixed in under the voice, ducked while it speaks.
// The Kokoro model (~90 MB) downloads from Hugging Face on first use and is cached in node_modules.
// Behind a TLS-inspecting proxy set NODE_EXTRA_CA_CERTS to its CA certificate.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Track } from './camera.ts';
import { renderSfx, SFX_MIX, sfxEvents, type SoundOptions } from './sound.ts';

export interface Cue { t: number; say: string; file?: string }
interface Kokoro { generate(text: string, opts: { voice: string; speed: number }): Promise<{ save(path: string): Promise<void> | void }> }
/** Edge-TTS (network, neural): the multilingual engine — Kokoro is English-first. NARRATOR_VOICE e.g. ar-EG-Salma */
interface Edge { toStream(text: string, speed: number): import('node:stream').Readable }

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const rmSyncSafe = (f: string) => { try { rmSync(f); } catch { /* not there */ } };
const duration = (file: string) => Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).trim());

export function srtTime(s: number): string {
  const ms = Math.round(s * 1000), h = Math.floor(ms / 3_600_000), m = Math.floor(ms / 60_000) % 60, sec = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

/** Where the speech in a clip starts and ends (Kokoro pads ~0.3 s before and ~0.5 s after). */
export function speechSpan(file: string): { from: number; to: number } {
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

async function loadKokoro(): Promise<Kokoro | undefined> {
  let mod: { KokoroTTS: { from_pretrained(id: string, o: object): Promise<Kokoro> } };
  try { mod = await import('kokoro-js'); } catch { return undefined; } // not installed: fall back to say
  return mod.KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
}

/** The narrator voice: Kokoro if installed (and not NARRATOR_ENGINE=say|edge), else macOS say. NARRATOR_ENGINE=edge + NARRATOR_VOICE=<locale-Voice> speaks any language Edge-TTS covers (ar-EG-Salma, ar-SA-Hamed…). */
export class Voice {
  readonly #kokoro: Kokoro | undefined;
  readonly #edge: Edge | undefined;
  readonly name: string;
  readonly ext: string;
  readonly speed: number;
  readonly #rate = Number(process.env.NARRATOR_RATE ?? 185);
  private constructor(kokoro: Kokoro | undefined, edge: Edge | undefined) {
    this.#kokoro = kokoro; this.#edge = edge;
    this.name = process.env.NARRATOR_VOICE ?? (edge ? 'ar-EG-SalmaNeural' : kokoro ? 'af_heart' : 'Samantha');
    this.ext = edge ? 'mp3' : kokoro ? 'wav' : 'aiff';
    this.speed = Number(process.env.NARRATOR_SPEED ?? 1);
    if (!(this.speed >= 0.5 && this.speed <= 2)) throw new Error(`NARRATOR_SPEED must be 0.5–2, got ${process.env.NARRATOR_SPEED}`);
  }
  static async load(): Promise<Voice> {
    const engine = process.env.NARRATOR_ENGINE ?? 'kokoro';
    const kokoro = engine === 'kokoro' ? await loadKokoro() : undefined;
    if (engine === 'kokoro' && !kokoro) console.error('kokoro-js is not installed (npm install in this folder); using macOS say');
    let edge: Edge | undefined;
    if (engine === 'edge') {
      const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
      const tts = new MsEdgeTTS() as unknown as { setMetadata(v: string, f: string): Promise<void>; toStream(t: string, o?: { rate?: number }): { audioStream: import('node:stream').Readable } };
      await tts.setMetadata(process.env.NARRATOR_VOICE ?? 'ar-EG-SalmaNeural', (OUTPUT_FORMAT as Record<string, string>).AUDIO_24KHZ_48KBITRATE_MONO_MP3 ?? 'audio-24khz-48kbitrate-mono-mp3');
      // rate: SSML's relative multiplier, so NARRATOR_SPEED and narrate's speed-up for a tight cue work as for Kokoro
      edge = { toStream: (text: string, speed: number) => tts.toStream(text, { rate: speed }).audioStream };
    }
    return new Voice(kokoro, edge);
  }
  /** Speak `text` into `file`; returns its length in seconds — measured the same way for every engine
   *  (record.ts measures each clip once, up front, and speechSpan() finds where its speech ends). */
  async speak(text: string, file: string, speed = this.speed): Promise<number> {
    if (this.#edge) await this.#edgeToFile(text, file, speed);
    else if (this.#kokoro) await (await this.#kokoro.generate(text, { voice: this.name, speed })).save(file);
    else run('say', ['-v', this.name, '-r', String(Math.round(this.#rate * speed)), '-o', file, text]);
    return duration(file);
  }
  async #edgeToFile(text: string, file: string, speed: number): Promise<void> {
    const stream = this.#edge!.toStream(text, speed);
    const fs = await import('node:fs');
    rmSyncSafe(file);
    await new Promise<void>((ok, fail) => {
      stream.on('data', (c: Buffer) => { if (Buffer.isBuffer(c) && c.length) fs.appendFileSync(file, c); });
      stream.on('end', ok); stream.on('error', fail); stream.on('close', () => ok());
    });
    if (!existsSync(file)) throw new Error(`Edge-TTS returned no audio for "${text.slice(0, 40)}" (network or voice name ${this.name}?)`);
  }
}

/** Lay the clips onto the video at their times, normalise loudness, write <video>-narrated.mp4 + .srt.
 *  `sfx`: a WAV of UI sounds (scripts/sound.ts) to mix in under the normalised voice. */
export function mixNarration(video: string, clips: Array<Cue & { file: string; d: number }>, sfx?: string): string {
  const total = duration(video);
  const out = video.replace(/\.(webm|mp4)$/, '') + '-narrated.mp4';
  const inputs = clips.flatMap(c => ['-i', c.file]);
  const delays = clips.map((c, i) => `[${i + 1}:a]adelay=${Math.round(c.t * 1000)}|${Math.round(c.t * 1000)},aresample=48000[a${i}]`).join(';');
  // loudnorm: Kokoro and say come out at different levels; -16 LUFS is the usual level for spoken video
  const voice = `${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11`;
  const mix = sfx ? `${voice},aresample=48000[voice];${SFX_MIX('[voice]', `[${clips.length + 1}:a]`, '[aud]')}` : `${voice},apad[aud]`;
  run('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, ...inputs, ...(sfx ? ['-i', sfx] : []), '-filter_complex', `${delays};${mix}`,
    '-map', '0:v', '-map', '[aud]', '-t', String(total), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out]);
  const srt = clips.map((c, i) => `${i + 1}\n${srtTime(c.t)} --> ${srtTime(Math.min(c.t + c.d, clips[i + 1]?.t ?? total))}\n${c.say}\n`).join('\n');
  writeFileSync(out.replace(/\.mp4$/, '.srt'), srt);
  return out;
}

async function main(): Promise<void> {
  const [video, cuesFile] = process.argv.slice(2);
  if (!video || !cuesFile) throw new Error('usage: node scripts/narrate.ts <video> <cues.json>');
  const cues = (JSON.parse(readFileSync(cuesFile, 'utf8')) as Cue[]).sort((a, b) => a.t - b.t);
  const total = duration(video);
  const dir = mkdtempSync(join(tmpdir(), 'narrate-'));
  let voice: Voice | undefined;

  // one clip per cue; a pre-made clip (speech-timed recording) is used as it is. Otherwise a line that would run
  // into the next cue is spoken faster (up to 1.3×), never overlapped.
  const clips: Array<Cue & { file: string; d: number }> = [];
  for (const [i, cue] of cues.entries()) {
    if (cue.file) { clips.push({ ...cue, file: resolve(cue.file), d: duration(resolve(cue.file)) }); continue; }
    voice ??= await Voice.load();
    const room = (cues[i + 1]?.t ?? total) - cue.t - 0.3;
    const file = join(dir, `cue${i}.${voice.ext}`);
    for (let speed = voice.speed; ; speed = Math.round(speed * 110) / 100) {
      const d = await voice.speak(cue.say, file, speed);
      if (d <= room || speed >= voice.speed * 1.3) {
        if (d > room) console.error(`cue ${i + 1} ("${cue.say.slice(0, 40)}…") needs ${d.toFixed(1)} s but has ${room.toFixed(1)} s — shorten its text or lengthen the pause after it`);
        clips.push({ ...cue, file, d });
        break;
      }
    }
  }
  // polish sound: render the UI sounds again, ducked under the (new) lines
  const trackFile = video.replace(/(-narrated)?\.(webm|mp4)$/, '') + '.track.json';
  const track = existsSync(trackFile) ? (JSON.parse(readFileSync(trackFile, 'utf8')) as Track) : undefined;
  const sound = (track?.polish as { sound?: SoundOptions } | undefined)?.sound;
  const sfx = track && sound && renderSfx(sfxEvents(track), clips.map(c => [c.t, c.t + c.d]), total, trackFile.replace(/\.track\.json$/, '.sfx.wav'), sound);
  console.log(mixNarration(video, clips, sfx || undefined));
}

// run only as a script; record.ts imports Voice and mixNarration
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
