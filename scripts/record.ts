// Record a showcase video of a web UI from a tour file: a drawn pointer that glides to each click target and
// ripples where it clicks (headless video has no cursor), captions, and caption timings for the narrator.
//   node scripts/record.ts <tour.json> [--var name=value …] [--no-narrate]
//   → <out>.mp4, <out>.cues.json, and (unless --no-narrate) <out>-narrated.mp4 + .srt via scripts/narrate.ts
// Uses the installed Google Chrome (no browser download); DEMO_BROWSER=msedge|chromium to change.
// Frames come from Chrome's screencast and are encoded by the system ffmpeg, so Playwright's own video
// recorder (which needs a matching ffmpeg download) is not used.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type CDPSession, type Locator, type Page } from 'playwright-core';

/** One tour step. Exactly one action key per step; `optional: true` skips a missing target instead of failing. */
export type Step =
  | { goto: string; waitFor?: string }
  | { caption: string; say?: string }
  | { pause: number }
  | { click: string; optional?: boolean; last?: boolean }
  | { type: string; text: string; delayMs?: number }
  | { fill: string; text: string }
  | { press: string }
  | { clickUntil: string; attr: [string, string]; equals: string | null; max?: number };

export interface Tour {
  base: string;
  out: string;
  viewport?: { width: number; height: number };
  colorScheme?: 'light' | 'dark';
  steps: Step[];
}

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Replace {{name}} with --var values; an unknown name is an error, not an empty string. */
export function substitute(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (!(name in vars)) throw new Error(`tour uses {{${name}}} but no --var ${name}=… was given`);
    return vars[name];
  });
}

const POINTER = `(() => {
  const css = document.createElement('style');
  css.textContent = '#demo-pointer{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transition:transform .6s cubic-bezier(.3,.7,.2,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}'
    + '.demo-ripple{position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;border:3px solid rgba(20,20,20,.75);box-shadow:0 0 0 2px #fff,inset 0 0 0 2px #fff;background:rgba(255,255,255,.25);z-index:2147483646;pointer-events:none;animation:demo-ripple .9s ease-out forwards}'
    + '@keyframes demo-ripple{from{transform:scale(.5);opacity:1}to{transform:scale(3.6);opacity:0}}'
    + '#demo-caption{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483645;max-width:80vw;padding:10px 18px;border-radius:10px;background:rgba(20,20,20,.82);color:#fff;font:600 16px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3);pointer-events:none}';
  const add = () => {
    document.head.append(css);
    const p = document.createElement('div');
    p.id = 'demo-pointer';
    p.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2l15 9-6.5 1.6L8 19z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const at = JSON.parse(sessionStorage.getItem('demo-pointer') || '[' + innerWidth / 2 + ',' + innerHeight / 2 + ']');
    p.style.transform = 'translate(' + at[0] + 'px,' + at[1] + 'px)';
    document.body.append(p);
  };
  if (document.body) add(); else addEventListener('DOMContentLoaded', add);
  window.__demoMove = (x, y) => { sessionStorage.setItem('demo-pointer', JSON.stringify([x, y])); const p = document.getElementById('demo-pointer'); if (p) p.style.transform = 'translate(' + x + 'px,' + y + 'px)'; };
  window.__demoRipple = (x, y) => { const r = document.createElement('div'); r.className = 'demo-ripple'; r.style.left = x + 'px'; r.style.top = y + 'px'; document.body.append(r); setTimeout(() => r.remove(), 1000); };
  window.__demoCaption = (t) => { let el = document.getElementById('demo-caption'); if (!el) { el = document.createElement('div'); el.id = 'demo-caption'; document.body.append(el); } el.textContent = t; };
})()`;

type DemoWindow = { __demoMove(x: number, y: number): void; __demoRipple(x: number, y: number): void; __demoCaption(t: string): void };

async function clickWithPointer(page: Page, loc: Locator): Promise<void> {
  const box = await loc.boundingBox();
  if (box) {
    const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
    await page.evaluate(([px, py]) => (window as unknown as DemoWindow).__demoMove(px, py), [x, y]);
    await pause(700); // the pointer's glide
    await page.evaluate(([px, py]) => (window as unknown as DemoWindow).__demoRipple(px, py), [x, y]);
  }
  await loc.click();
}

/**
 * Chrome's screencast sends a frame only when the screen changes; each is written with its timestamp and later
 * held on screen until the next one (ffmpeg concat with durations), then resampled to a constant frame rate.
 */
class Screencast {
  readonly #frames: Array<{ file: string; ts: number }> = [];
  readonly #dir = mkdtempSync(join(tmpdir(), 'screencast-'));
  #cdp?: CDPSession;
  async start(page: Page, size: { width: number; height: number }): Promise<void> {
    this.#cdp = await page.context().newCDPSession(page);
    this.#cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      const file = join(this.#dir, `f${String(this.#frames.length).padStart(6, '0')}.jpg`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      this.#frames.push({ file, ts: metadata.timestamp ?? Date.now() / 1000 });
      void this.#cdp?.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await this.#cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 });
  }
  async stop(): Promise<void> { await this.#cdp?.send('Page.stopScreencast').catch(() => {}); }
  /** Encode to a constant-rate MP4 starting at `t0` (seconds); even dimensions, as x264 requires. */
  encode(out: string, t0: number, end: number, size: { width: number; height: number }): void {
    if (!this.#frames.length) throw new Error('screencast captured no frames');
    const lines: string[] = [];
    this.#frames.forEach((f, i) => {
      const next = this.#frames[i + 1]?.ts ?? end;
      const from = i === 0 ? t0 : f.ts;
      lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - from).toFixed(3)}`);
    });
    lines.push(`file '${this.#frames[this.#frames.length - 1].file}'`); // concat needs the last file repeated
    const list = join(this.#dir, 'frames.txt');
    writeFileSync(list, lines.join('\n'));
    const w = size.width - (size.width % 2), h = size.height - (size.height % 2);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:white,fps=30,format=yuv420p`,
      '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart', out]);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const tourFile = args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--var'));
  if (!tourFile) throw new Error('usage: node scripts/record.ts <tour.json> [--var name=value …] [--no-narrate]');
  const vars: Record<string, string> = {};
  args.forEach((a, i) => { if (a === '--var') { const [k, ...v] = args[i + 1].split('='); vars[k] = v.join('='); } });
  const tour = JSON.parse(substitute(readFileSync(tourFile, 'utf8'), vars)) as Tour;
  const viewport = tour.viewport ?? { width: 1440, height: 900 };
  const out = resolve(dirname(tourFile), tour.out);
  mkdirSync(dirname(out), { recursive: true });

  const browser = await chromium.launch({ channel: process.env.DEMO_BROWSER ?? 'chrome' });
  const context = await browser.newContext({ viewport, colorScheme: tour.colorScheme ?? 'light' });
  await context.addInitScript(POINTER);
  const page = await context.newPage();
  const cast = new Screencast();
  await cast.start(page, viewport);
  const t0 = Date.now(); // the video starts here
  const cues: Array<{ t: number; say: string; caption: string }> = [];

  for (const step of tour.steps) {
    if ('goto' in step) {
      await page.goto(new URL(step.goto, tour.base).href);
      if (step.waitFor) await page.waitForSelector(step.waitFor, { timeout: 20_000 }).catch(() => {});
    } else if ('caption' in step) {
      cues.push({ t: (Date.now() - t0) / 1000, caption: step.caption, say: step.say ?? step.caption });
      await page.evaluate(t => (window as unknown as DemoWindow).__demoCaption(t), step.caption);
    } else if ('pause' in step) {
      await pause(step.pause);
    } else if ('click' in step) {
      const all = page.locator(step.click);
      if (!(await all.count())) { if (step.optional) continue; throw new Error(`click: nothing matches ${step.click}`); }
      await clickWithPointer(page, step.last ? all.last() : all.first());
    } else if ('type' in step) {
      await clickWithPointer(page, page.locator(step.type).first());
      for (const ch of step.text) { await page.keyboard.type(ch); await pause(step.delayMs ?? 110); }
    } else if ('fill' in step) {
      await page.locator(step.fill).first().fill(step.text);
    } else if ('press' in step) {
      await page.keyboard.press(step.press);
    } else if ('clickUntil' in step) {
      const [sel, attr] = step.attr;
      for (let i = 0; i < (step.max ?? 4) && (await page.getAttribute(sel, attr)) !== step.equals; i++) {
        await clickWithPointer(page, page.locator(step.clickUntil).first());
        await pause(300);
      }
    }
  }

  const end = Date.now();
  await cast.stop();
  await context.close();
  await browser.close();
  const video = `${out}.mp4`;
  cast.encode(video, t0 / 1000, end / 1000, viewport);
  const cuesFile = `${out}.cues.json`;
  writeFileSync(cuesFile, JSON.stringify(cues, null, 2));
  console.log(video);
  if (!args.includes('--no-narrate')) {
    const narrate = join(dirname(fileURLToPath(import.meta.url)), 'narrate.ts');
    console.log(execFileSync(process.execPath, [narrate, video, cuesFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim());
  }
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
