// Record a showcase video of a web UI from a tour file: a drawn pointer that glides to each click target and
// ripples where it clicks (headless video has no cursor), captions, and caption timings for the narrator.
//   node scripts/record.ts <tour.json> [--var name=value …] [--no-narrate]
//   → <out>.mp4, <out>.cues.json, and (unless --no-narrate) <out>-narrated.mp4 + .srt via scripts/narrate.ts
//   --polish camera,sound,…  turn on exactly these polish features (scripts/polish.ts), overriding the tour's "polish"
// Uses the installed Google Chrome (no browser download); DEMO_BROWSER=msedge|chromium to change.
// Frames come from Chrome's screencast and are encoded by the system ffmpeg, so Playwright's own video
// recorder (which needs a matching ffmpeg download) is not used.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type CDPSession, type Locator, type Page } from 'playwright-core';
import type { Sample, Track, TrackEvent } from './camera.ts';
import { mixNarration, speechSpan, Voice } from './narrate.ts';
import { cardSeconds, renderPolish, resolvePolish, type Polish } from './polish.ts';
import { renderSfx, sfxEvents } from './sound.ts';

/** One tour step. Exactly one action key per step; `optional: true` skips a missing target instead of failing;
 *  `camera: false` (polish camera) shows the full view while the step runs. */
export type Step = { camera?: false } & (
  | { goto: string; waitFor?: string }
  | { caption: string; say?: string; focus?: string | null }
  | { focus: string | null }
  | { pause: number; hold?: boolean }
  | { click: string; optional?: boolean; last?: boolean }
  | { type: string; text: string; delayMs?: number }
  | { fill: string; text: string }
  | { press: string }
  | { hover: string }
  | { waitForVoice: true | number }
  | { clickUntil: string; attr: [string, string]; equals: string | null; max?: number });

export interface Tour {
  base: string;
  /** speech (default): each caption holds exactly as long as its spoken line and plain pauses are skipped;
   *  pauses: the tour's own pause steps set the timing (lines are fitted to them afterwards).
   *  flow: like speech, but a line doesn't block: the steps after it run while it is spoken, and the next
   *  caption waits only for the voice to finish, so narration runs continuously over clicks, typing and loading. */
  timing?: 'speech' | 'pauses' | 'flow';
  out: string;
  viewport?: { width: number; height: number };
  colorScheme?: 'light' | 'dark';
  /** optional extras, all off unless set: camera, sound, frame, cards, blur (scripts/polish.ts, README) */
  polish?: Record<string, unknown>;
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
  // the intro card's colours; polish cards set them (window.__demoLook), else the default dark grey
  const look = window.__demoLook || {}, cardBg = look.bg || 'radial-gradient(circle at 50% 40%,#2b2f3a,#111318)', cardFg = look.fg || '#fff';
  const css = document.createElement('style');
  // Overlay lives in a manual popover: the top layer, so it also covers modal <dialog>s (no z-index can beat those)
  css.textContent = '#demo-layer{position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;color:inherit;overflow:visible;pointer-events:none}'
    + '#demo-title{position:fixed;inset:0;display:grid;place-content:center;text-align:center;z-index:2147483643;background:' + cardBg + ';color:' + cardFg + ';font-family:-apple-system,BlinkMacSystemFont,sans-serif}'
    + '#demo-title b{display:block;font-size:52px;letter-spacing:-.02em}#demo-title span{display:block;margin-top:14px;font-size:22px;color:#c9ced8}'
    + '#demo-layer:has(#demo-title) #demo-pointer{visibility:hidden}'
    + '#demo-pointer{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transition:transform .6s cubic-bezier(.3,.7,.2,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}'
    + '.demo-ripple{position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;border:3px solid rgba(20,20,20,.75);box-shadow:0 0 0 2px #fff,inset 0 0 0 2px #fff;background:rgba(255,255,255,.25);z-index:2147483646;pointer-events:none;animation:demo-ripple .9s ease-out forwards}'
    + '@keyframes demo-ripple{from{transform:scale(.5);opacity:1}to{transform:scale(3.6);opacity:0}}'
    + '#demo-focus{position:fixed;z-index:2147483644;pointer-events:none;border:3px solid #ff6b1a;border-radius:10px;box-shadow:0 0 0 9999px rgba(15,15,15,.28),0 0 18px rgba(255,107,26,.55);transition:all .35s ease;opacity:0}'
    + '#demo-caption{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483645;max-width:80vw;padding:10px 18px;border-radius:10px;background:rgba(20,20,20,.82);color:#fff;font:600 16px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3);pointer-events:none}';
  const layer = () => {
    let l = document.getElementById('demo-layer');
    if (!l) { l = document.createElement('div'); l.id = 'demo-layer'; l.setAttribute('popover', 'manual'); document.body.append(l); l.showPopover?.(); }
    return l;
  };
  // A dialog or popover opened later stacks above ours; re-show ours whenever that set changes to stay on top
  let topKey = '';
  const raise = () => {
    const l = document.getElementById('demo-layer');
    if (l && l.showPopover) {
      const open = [...document.querySelectorAll('dialog:modal, [popover]:popover-open')].filter((e) => e !== l);
      const key = open.map((e) => e.id || e.tagName).join('|') + '#' + open.length;
      if (key !== topKey) { topKey = key; if (l.matches(':popover-open')) l.hidePopover(); l.showPopover(); }
    }
    requestAnimationFrame(raise);
  };
  // Intro title still showing while the app loads: cover the page from its very first paint. The recorder puts the
  // title in a cookie for the app's origin, which is readable synchronously here, before the document has a body.
  let early; try { early = (document.cookie.match(/(?:^|; )demo_title=([^;]*)/) || [])[1]; } catch { /* about:blank, data: — no cookies */ }
  if (early) {
    const cover = document.createElement('div');
    cover.id = 'demo-title-early';
    cover.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-content:center;text-align:center;color:' + cardFg + ';font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:' + cardBg;
    const [title, ...sub] = decodeURIComponent(early).split(' · ');
    const tb = document.createElement('b'); tb.textContent = title; tb.style.cssText = 'display:block;font-size:52px;letter-spacing:-.02em';
    cover.append(tb);
    if (sub.length) { const ts = document.createElement('span'); ts.textContent = sub.join(' · '); ts.style.cssText = 'display:block;margin-top:14px;font-size:22px;color:#c9ced8'; cover.append(ts); }
    // init scripts run before <html> exists: attach the cover the moment it does, still before the first paint
    const put = () => { if (!document.documentElement) return false; document.documentElement.append(cover); return true; };
    if (!put()) { const mo = new MutationObserver(() => { if (put()) mo.disconnect(); }); mo.observe(document, { childList: true }); }
  }
  const add = () => {
    document.head.append(css);
    layer();
    requestAnimationFrame(raise);
    if (early) { window.__demoTitle(decodeURIComponent(early)); document.getElementById('demo-title-early')?.remove(); }
    window.__demoTitleText?.().then((t) => t && window.__demoTitle(t)); // intro title still showing: keep covering the loading page
    const p = document.createElement('div');
    p.id = 'demo-pointer';
    p.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2l15 9-6.5 1.6L8 19z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const saved = sessionStorage.getItem('demo-pointer'); // hidden until its first move, so it never sits in a random spot
    if (saved) { const at = JSON.parse(saved); p.style.transform = 'translate(' + at[0] + 'px,' + at[1] + 'px)'; } else p.style.opacity = '0';
    layer().append(p);
  };
  if (document.body) add(); else addEventListener('DOMContentLoaded', add);
  window.__demoMove = (x, y) => { sessionStorage.setItem('demo-pointer', JSON.stringify([x, y])); const p = document.getElementById('demo-pointer'); if (p) { const first = p.style.opacity === '0'; if (first) p.style.transition = 'none'; p.style.transform = 'translate(' + x + 'px,' + y + 'px)'; if (first) { void p.offsetWidth; p.style.transition = ''; } p.style.opacity = '1'; } };
  window.__demoRipple = (x, y) => { const r = document.createElement('div'); r.className = 'demo-ripple'; r.style.left = x + 'px'; r.style.top = y + 'px'; layer().append(r); setTimeout(() => r.remove(), 1000); };
  // Spotlight: frame the element being talked about and dim the rest; it follows the element while it moves.
  // by selector, looked up every frame: live pages re-render, which would orphan a remembered element
  let focusSel = null;
  const track = () => {
    const box = document.getElementById('demo-focus');
    const focusEl = focusSel ? document.querySelector(focusSel) : null;
    if (box && focusEl) {
      const r = focusEl.getBoundingClientRect(), pad = 6;
      box.style.left = (r.left - pad) + 'px'; box.style.top = (r.top - pad) + 'px';
      box.style.width = (r.width + 2 * pad) + 'px'; box.style.height = (r.height + 2 * pad) + 'px';
      box.style.opacity = '1';
    } else if (box) box.style.opacity = '0';
    requestAnimationFrame(track);
  };
  window.__demoFocus = (sel) => {
    focusSel = sel;
    let box = document.getElementById('demo-focus');
    if (!box) { box = document.createElement('div'); box.id = 'demo-focus'; layer().append(box); requestAnimationFrame(track); }
  };
  window.__demoTitle = (t) => {
    document.getElementById('demo-title')?.remove();
    if (!t) return;
    const [title, ...sub] = t.split(' · ');
    const el = document.createElement('div'); el.id = 'demo-title';
    const b = document.createElement('b'); b.textContent = title; el.append(b);
    if (sub.length) { const s = document.createElement('span'); s.textContent = sub.join(' · '); el.append(s); }
    layer().append(el);
  };
  window.__demoCaption = (t) => { let el = document.getElementById('demo-caption'); if (!el) { el = document.createElement('div'); el.id = 'demo-caption'; layer().append(el); } el.textContent = t; };
  // Polish: sample the pointer, the focus area and the intro card every ~33 ms for the virtual camera; the recorder
  // collects them with __demoTrackTake (window.__demoTrackOn is set only when a polish feature is on)
  if (window.__demoTrackOn) {
    let buf = [], last = 0;
    const sample = () => {
      const now = Date.now();
      if (now - last >= 30) {
        last = now;
        const s = { t: now }, p = document.getElementById('demo-pointer');
        const card = document.getElementById('demo-title') || document.getElementById('demo-title-early');
        if (card) s.card = true;
        else if (p && p.style.opacity !== '0') { const m = new DOMMatrixReadOnly(getComputedStyle(p).transform); s.p = [m.m41, m.m42]; }
        const f = focusSel ? document.querySelector(focusSel) : null, r = f && f.getBoundingClientRect();
        if (r && (r.width || r.height)) s.f = [r.left - 6, r.top - 6, r.right + 6, r.bottom + 6]; // as the mark's frame
        buf.push(s);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    window.__demoTrackTake = () => { const b = buf; buf = []; return { origin: performance.timeOrigin, samples: b }; };
  }
})()`;

const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
// Full-screen title for a caption placed before the first goto; " · " splits it into title and subtitle
const TITLE_CARD = (caption: string, look?: { bg: string; fg: string }) => {
  const [title, ...sub] = caption.split(' · ');
  return '<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-content:center;text-align:center;'
    + `background:${look?.bg ?? 'radial-gradient(circle at 50% 40%,#2b2f3a,#111318)'};color:${look?.fg ?? '#fff'};font-family:-apple-system,BlinkMacSystemFont,sans-serif">`
    + `<div style="font-size:52px;font-weight:700;letter-spacing:-.02em">${esc(title)}</div>`
    + (sub.length ? `<div style="margin-top:14px;font-size:22px;color:#c9ced8">${esc(sub.join(' · '))}</div>` : '')
    + '</body></html>';
};

/**
 * Polish only: what happened when, for the virtual camera and the sounds (<out>.track.json). The page samples the
 * pointer and focus every frame; this collects them every 250 ms (and before each navigation) and adds the
 * recorder's own events: page loads, clicks, keys, lines, scrolls.
 */
class Tracker {
  readonly samples: Sample[] = [];
  readonly events: TrackEvent[] = [];
  readonly #origins = new Set<number>();
  #timer?: ReturnType<typeof setInterval>;
  readonly page: Page;
  readonly t0: number;
  constructor(page: Page, t0: number) { this.page = page; this.t0 = t0; }
  now(): number { return (Date.now() - this.t0) / 1000; }
  event(e: Omit<TrackEvent, 't'> & { t?: number }): TrackEvent { const ev = { t: this.now(), ...e }; this.events.push(ev); return ev; }
  start(): void { this.#timer = setInterval(() => void this.take(), 250); }
  stop(): void { clearInterval(this.#timer); }
  async take(): Promise<void> {
    const got = await this.page.evaluate(() => (window as unknown as { __demoTrackTake?(): { origin: number; samples: Sample[] } }).__demoTrackTake?.()).catch(() => undefined);
    if (!got) return;
    // a new document: a page load (goto, or a link the tour clicked)
    if (!this.#origins.has(got.origin)) { this.#origins.add(got.origin); if (got.origin > this.t0) this.event({ type: 'doc', t: (got.origin - this.t0) / 1000 }); }
    for (const smp of got.samples) this.samples.push({ ...smp, t: (smp.t - this.t0) / 1000 });
  }
}
let tracker: Tracker | undefined;

type DemoWindow = { __demoTitle(t: string | null): void; __demoMove(x: number, y: number): void; __demoRipple(x: number, y: number): void; __demoCaption(t: string): void; __demoFocus(selector: string | null): void };

/** Smooth-scroll the element to the middle of its scroll container(s) and the window; wait for the scroll to settle. */
async function centre(page: Page, loc: Locator): Promise<void> {
  const moved = await loc.evaluate(el => {
    const r = el.getBoundingClientRect();
    const off = Math.abs(r.top + r.height / 2 - innerHeight / 2) > innerHeight * 0.15 || r.top < 0 || r.bottom > innerHeight;
    if (off) el.scrollIntoView({ block: r.height > innerHeight * 0.8 ? 'start' : 'center', inline: 'nearest', behavior: 'smooth' });
    return off;
  }).catch(() => false);
  if (moved) { tracker?.event({ type: 'scroll', end: tracker.now() + 0.8 }); await pause(800); }
}

async function focusOn(page: Page, selector: string | null): Promise<void> {
  tracker?.event({ type: 'focus' }); // attention moves on now (the mark follows after the scroll)
  if (selector === null) { await page.evaluate(() => (window as unknown as DemoWindow).__demoFocus(null)); return; }
  const loc = page.locator(selector).first();
  // a click just before this (flow timing) may still be rendering the target: wait a little for it
  await loc.waitFor({ state: 'attached', timeout: 3000 }).catch(() => {});
  const present = (await loc.count()) > 0;
  if (present) await centre(page, loc);
  else console.error(`focus: nothing matches ${selector} yet; the mark appears if it renders later`);
  // set either way: the mark looks the selector up every frame, so a late element still gets marked
  await page.evaluate(sel => (window as unknown as DemoWindow).__demoFocus(sel), selector);
  await pause(350); // the frame's fade-in
}

async function movePointer(page: Page, loc: Locator): Promise<void> {
  await centre(page, loc);
  const box = await loc.boundingBox();
  if (!box) return;
  const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
  await page.evaluate(([px, py]) => (window as unknown as DemoWindow).__demoMove(px, py), [x, y]);
  await pause(700);
}

async function clickWithPointer(page: Page, loc: Locator): Promise<void> {
  await centre(page, loc);
  const box = await loc.boundingBox();
  if (box) {
    const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
    await page.evaluate(([px, py]) => (window as unknown as DemoWindow).__demoMove(px, py), [x, y]);
    await pause(700); // the pointer's glide
    await page.evaluate(([px, py]) => (window as unknown as DemoWindow).__demoRipple(px, py), [x, y]);
    tracker?.event({ type: 'click', x, y });
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
  /** Encode to a constant-rate MP4 starting at `t0` (seconds); even dimensions, as x264 requires.
   *  `x264` replaces the default quality (polish: a near-lossless intermediate, re-rendered by scripts/polish.ts). */
  encode(out: string, t0: number, end: number, size: { width: number; height: number }, x264 = ['-crf', '20']): void {
    if (!this.#frames.length) throw new Error('screencast captured no frames');
    const lines: string[] = [];
    // in capture order: frames can arrive out of order, and clamping each negative gap to 1 ms made the video run
    // seconds behind the clock (behind the captions, the camera and the voice)
    const frames = [...this.#frames].sort((a, b) => a.ts - b.ts);
    frames.forEach((f, i) => {
      const next = frames[i + 1]?.ts ?? end;
      const from = i === 0 ? t0 : f.ts;
      lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - from).toFixed(3)}`);
    });
    lines.push(`file '${frames[frames.length - 1].file}'`); // concat needs the last file repeated
    const list = join(this.#dir, 'frames.txt');
    writeFileSync(list, lines.join('\n'));
    const w = size.width - (size.width % 2), h = size.height - (size.height % 2);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:white,fps=30:start_time=0,tpad=stop_mode=clone:stop_duration=5,format=yuv420p`,
      // start_time=0: else the video starts at the 2nd frame and runs ahead of the voice; concat also mishandles the
      // last entry's duration, so pad by cloning the last frame and cut at the recorded length
      '-t', (end - t0).toFixed(3), '-c:v', 'libx264', ...x264, '-movflags', '+faststart', out]);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const tourFile = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--var') && args[i - 1] !== '--polish');
  if (!tourFile) throw new Error('usage: node scripts/record.ts <tour.json> [--var name=value …] [--polish camera,sound,…] [--no-narrate]');
  const vars: Record<string, string> = {};
  args.forEach((a, i) => { if (a === '--var') { const [k, ...v] = args[i + 1].split('='); vars[k] = v.join('='); } });
  const tour = JSON.parse(substitute(readFileSync(tourFile, 'utf8'), vars)) as Tour;
  const viewport = tour.viewport ?? { width: 1440, height: 900 };
  const out = resolve(dirname(tourFile), tour.out);
  mkdirSync(dirname(out), { recursive: true });
  const cli = args.indexOf('--polish');
  const polish: Polish | null = resolvePolish(tour.polish, cli >= 0 ? args[cli + 1] ?? '' : undefined, dirname(resolve(tourFile)), tour.colorScheme ?? 'light');
  // camera or window frame: capture at twice the pixels, so a zoomed or scaled-up view stays sharp
  const dsf = polish?.camera || polish?.frame ? 2 : 1;
  const look = polish?.cards && { bg: polish.cards.background, fg: polish.cards.color };

  // speech-timed: speak every line first, so each caption can hold exactly as long as its line
  const speechTimed = (tour.timing ?? 'speech') !== 'pauses' && !args.includes('--no-narrate');
  const flow = speechTimed && tour.timing === 'flow';
  let voiceFree = 0; // flow: when the line being spoken ends
  let lineDone = 0; // speech timing: when the last line (and its breath) ended
  // spokenTo: when the voice ends inside the clip, measured here (ffmpeg, slow on a busy machine), not while recording
  const lines = new Map<number, { file: string; d: number; spokenTo?: number }>();
  if (speechTimed) {
    const voice = await Voice.load();
    const voiceDir = `${out}.voice`;
    mkdirSync(voiceDir, { recursive: true });
    for (const [i, step] of tour.steps.entries()) {
      if (!('caption' in step)) continue;
      const file = join(voiceDir, `step${i}.${voice.ext}`);
      const d = await voice.speak(step.say ?? step.caption, file);
      lines.set(i, { file, d, spokenTo: speechSpan(file).to });
    }
    const spoken = [...lines.values()].reduce((s, l) => s + l.d, 0);
    console.error(`narration: ${lines.size} lines, ${spoken.toFixed(1)} s of speech`);
  }

  // the screencast sends CSS-px-sized frames unless the browser window itself renders at the higher scale
  const browser = await chromium.launch({ channel: process.env.DEMO_BROWSER ?? 'chrome', ...(dsf > 1 ? { args: [`--force-device-scale-factor=${dsf}`] } : {}) });
  const context = await browser.newContext({ viewport, colorScheme: tour.colorScheme ?? 'light', ...(dsf > 1 ? { deviceScaleFactor: dsf } : {}) });
  if (polish) await context.addInitScript('window.__demoTrackOn = true;'); // before POINTER, which reads them
  if (look) await context.addInitScript(`window.__demoLook = ${JSON.stringify(look)};`);
  let titleText: string | null = null; // the intro title card, kept over page loads until the next caption
  await context.exposeFunction('__demoTitleText', () => titleText);
  await context.addInitScript(POINTER);
  const page = await context.newPage();
  // a tour that opens on a title card: show it before the screencast starts, else the first frame is the blank white
  // about:blank page, stretched back to t0 (a white flash, and polish's title card cross-fades into it)
  const first = tour.steps[0];
  if (first && 'caption' in first) await page.setContent(TITLE_CARD(first.caption, look || undefined));
  const cast = new Screencast();
  await cast.start(page, { width: viewport.width * dsf, height: viewport.height * dsf });
  const t0 = Date.now(); // the video starts here
  if (polish) { tracker = new Tracker(page, t0); tracker.start(); }
  const cues: Array<{ t: number; say: string; caption: string; file?: string; d?: number }> = [];
  const typing: Array<[number, number]> = []; // when each `type` step typed (s), so tighten.ts keeps it readable

  for (const [index, step] of tour.steps.entries()) {
    const stepStart = Date.now();
    if ('goto' in step) {
      await tracker?.take(); // the old page's last samples
      const nav = tracker?.event({ type: 'goto' });
      await page.goto(new URL(step.goto, tour.base).href);
      if (step.waitFor) await page.waitForSelector(step.waitFor, { timeout: 20_000 }).catch(() => {});
      if (nav) nav.end = tracker!.now();
    } else if ('caption' in step) {
      const line = lines.get(index);
      const titleCard = !/^https?:/.test(page.url()); // before the first goto: a title card, spoken while the app loads
      if (titleCard) {
        titleText = step.caption;
        await context.addCookies([{ name: 'demo_title', value: encodeURIComponent(step.caption), url: tour.base }]);
        await tracker?.take();
        await page.setContent(TITLE_CARD(step.caption, look || undefined));
      }
      else {
        if (titleText) { // the intro card stays until its line is over, then the (already loaded) app appears
          if (flow) await pause(voiceFree - Date.now());
          titleText = null;
          await context.clearCookies({ name: 'demo_title' });
          await page.evaluate(() => { document.getElementById('demo-title-early')?.remove(); (window as unknown as DemoWindow).__demoTitle(null); });
        }
        // centre and mark the area first, so the voice starts once the viewer is looking at it
        // (flow: while the previous line ends, like a presenter pointing at what comes next)
        if (step.focus !== undefined) await focusOn(page, step.focus);
      }
      if (flow) await pause(voiceFree - Date.now()); // never talk over the previous line
      if (polish?.camera && !titleCard) {
        // the camera moves only between lines: give it time to frame what this one is about before the voice starts
        const focused = tracker!.events.filter(e => e.type === 'focus').pop();
        const from = Math.max(flow ? voiceFree : lineDone, focused ? t0 + focused.t * 1000 : 0);
        await pause(from + (polish.camera.lead + polish.camera.smoothness) * 1000 - Date.now());
      }
      cues.push({ t: (Date.now() - t0) / 1000, caption: step.caption, say: step.say ?? step.caption, ...(line ? { file: line.file, d: line.d } : {}) });
      // d: until the voice ends (the clip's trailing silence is free for the camera to move)
      tracker?.event({ type: 'caption', text: step.caption, d: line?.spokenTo, ...(titleCard ? { card: true } : {}) });
      // camera or frame: polish.ts draws the caption over the output instead, where zooming can't crop it
      if (!titleCard && !polish?.captions) await page.evaluate(t => (window as unknown as DemoWindow).__demoCaption(t), step.caption);
      // keep going: the next steps run under this line; the next one may start in this clip's ~0.4 s trailing silence
      if (line && flow) voiceFree = Date.now() + line.d * 1000 - 350;
      else if (line) { await pause(line.d * 1000 + 150); lineDone = Date.now(); } // hold for the spoken line plus a breath, then move straight on
    } else if ('waitForVoice' in step) {
      // e.g. before a click that would change what the line describes; a number starts that many ms before it ends
      if (flow) await pause(voiceFree - Date.now() - (typeof step.waitForVoice === 'number' ? step.waitForVoice : 0));
    } else if ('focus' in step) {
      await focusOn(page, step.focus);
    } else if ('pause' in step) {
      if (!speechTimed || step.hold) await pause(step.pause); // speech-timed: only deliberate holds
    } else if ('click' in step) {
      const all = page.locator(step.click);
      if (!(await all.count())) { if (step.optional) continue; throw new Error(`click: nothing matches ${step.click}`); }
      await clickWithPointer(page, step.last ? all.last() : all.first());
    } else if ('type' in step) {
      await clickWithPointer(page, page.locator(step.type).first());
      const from = (Date.now() - t0) / 1000;
      for (const ch of step.text) { tracker?.event({ type: 'key' }); await page.keyboard.type(ch); await pause(step.delayMs ?? 110); }
      typing.push([from, (Date.now() - t0) / 1000]);
    } else if ('fill' in step) {
      await page.locator(step.fill).first().fill(step.text);
    } else if ('hover' in step) {
      await movePointer(page, page.locator(step.hover).first());
    } else if ('press' in step) {
      tracker?.event({ type: 'key' });
      await page.keyboard.press(step.press);
    } else if ('clickUntil' in step) {
      const [sel, attr] = step.attr;
      for (let i = 0; i < (step.max ?? 4) && (await page.getAttribute(sel, attr)) !== step.equals; i++) {
        await clickWithPointer(page, page.locator(step.clickUntil).first());
        await pause(300);
      }
    }
    if (step.camera === false) tracker?.event({ type: 'still', t: (stepStart - t0) / 1000, end: tracker.now() });
  }

  if (flow) await pause(voiceFree - Date.now() + 650); // let the last line (and its tail) finish on screen
  const end = Date.now();
  await tracker?.take();
  tracker?.stop();
  await cast.stop();
  await context.close();
  await browser.close();
  const video = `${out}.mp4`;
  let sfx: string | undefined;
  if (!polish || !tracker) cast.encode(video, t0 / 1000, end / 1000, viewport);
  else {
    // polish: a sharp intermediate + what happened when, then the camera, frame, cards and blur render <out>.mp4
    const raw = `${out}.raw.mp4`, cards = cardSeconds(polish);
    cast.encode(raw, t0 / 1000, end / 1000, { width: viewport.width * dsf, height: viewport.height * dsf }, ['-crf', '12', '-preset', 'veryfast']);
    const track: Track = { viewport, dsf, duration: (end - t0) / 1000, offset: cards.title, endCard: cards.end, colorScheme: tour.colorScheme ?? 'light',
      polish, samples: tracker.samples, events: tracker.events };
    writeFileSync(`${out}.track.json`, JSON.stringify(track));
    await renderPolish(out);
    for (const c of cues) c.t += cards.title; // the title card comes first
    for (const span of typing) { span[0] += cards.title; span[1] += cards.title; }
    if (polish.sound) {
      const spoken = cues.filter(c => c.d !== undefined).map((c): [number, number] => [c.t, c.t + c.d!]);
      sfx = renderSfx(sfxEvents(track), spoken, track.duration + cards.title + cards.end, `${out}.sfx.wav`, polish.sound);
    }
  }
  const cuesFile = `${out}.cues.json`;
  writeFileSync(cuesFile, JSON.stringify(cues, null, 2));
  writeFileSync(`${out}.typing.json`, JSON.stringify(typing));
  console.log(video);
  if (speechTimed) {
    console.log(mixNarration(video, cues.filter((c): c is typeof c & { file: string; d: number } => !!c.file), sfx));
  } else if (!args.includes('--no-narrate')) {
    const narrate = join(dirname(fileURLToPath(import.meta.url)), 'narrate.ts');
    console.log(execFileSync(process.execPath, [narrate, video, cuesFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim());
  }
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
