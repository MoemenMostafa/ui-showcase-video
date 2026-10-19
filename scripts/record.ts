// Record a showcase video of a web UI from a tour file: a drawn pointer that glides to each click target and
// ripples where it clicks (headless video has no cursor), captions, and caption timings for the narrator.
//   node scripts/record.ts <tour.json> [--var name=value …] [--no-narrate]
//   → <out>.mp4, <out>.cues.json, and (unless --no-narrate) <out>-narrated.mp4 + .srt via scripts/narrate.ts
// Uses the installed Google Chrome (no browser download); DEMO_BROWSER=msedge|chromium to change.
// Frames come from Chrome's screencast and are encoded by the system ffmpeg, so Playwright's own video
// recorder (which needs a matching ffmpeg download) is not used.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type CDPSession, type Locator, type Page } from 'playwright-core';
import { mixNarration, Voice } from './narrate.ts';

/** One tour step. Exactly one action key per step; `optional: true` skips a missing target instead of failing. */
export type Step =
  | { goto: string; waitFor?: string }
  | { caption: string; say?: string; focus?: string | null }
  | { focus: string | null }
  | { pause: number; hold?: boolean }
  | { click: string; optional?: boolean; last?: boolean; force?: boolean }
  | { clickXY: [number, number]; frame?: string }
  | { type: string; text: string; delayMs?: number }
  | { fill: string; text: string }
  | { press: string }
  | { hover: string }
  | { waitForVoice: true | number }
  | { clickUntil: string; attr: [string, string]; equals: string | null; max?: number };

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
  /** fake "you are here" for the find-my-vehicle beats — e.g. Cairo downtown */
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
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
  // Overlay lives in a manual popover: the top layer, so it also covers modal <dialog>s (no z-index can beat those)
  css.textContent = '#demo-layer{position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;color:inherit;overflow:visible;pointer-events:none}'
    + '#demo-title{position:fixed;inset:0;display:grid;place-content:center;text-align:center;z-index:2147483643;background:radial-gradient(circle at 50% 40%,#2b2f3a,#111318);color:#fff;font-family:-apple-system,BlinkMacSystemFont,sans-serif}'
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
  // CSP-hardening: pages with a strict style-src (e.g. checkout.stripe.com) silently drop the
  // <style> tag above, leaving the full-viewport layer WITHOUT pointer-events:none — it then
  // swallows every click. CSSOM injection cannot be blocked by CSP, so mirror the rules there too.
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css.textContent);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch { /* older engines keep the <style> fallback */ }
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
    cover.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-content:center;text-align:center;color:#fff;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:radial-gradient(circle at 50% 40%,#2b2f3a,#111318)';
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
})()`;

const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
// Full-screen title for a caption placed before the first goto; " · " splits it into title and subtitle
const TITLE_CARD = (caption: string) => {
  const [title, ...sub] = caption.split(' · ');
  return '<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-content:center;text-align:center;'
    + 'background:radial-gradient(circle at 50% 40%,#2b2f3a,#111318);color:#fff;font-family:-apple-system,BlinkMacSystemFont,sans-serif">'
    + `<div style="font-size:52px;font-weight:700;letter-spacing:-.02em">${esc(title)}</div>`
    + (sub.length ? `<div style="margin-top:14px;font-size:22px;color:#c9ced8">${esc(sub.join(' · '))}</div>` : '')
    + '</body></html>';
};

type DemoWindow = { __demoTitle(t: string | null): void; __demoMove(x: number, y: number): void; __demoRipple(x: number, y: number): void; __demoCaption(t: string): void; __demoFocus(selector: string | null): void };

/** Smooth-scroll the element to the middle of its scroll container(s) and the window; wait for the scroll to settle. */
async function centre(page: Page, loc: Locator): Promise<void> {
  const moved = await loc.evaluate(el => {
    const r = el.getBoundingClientRect();
    const off = Math.abs(r.top + r.height / 2 - innerHeight / 2) > innerHeight * 0.15 || r.top < 0 || r.bottom > innerHeight;
    if (off) el.scrollIntoView({ block: r.height > innerHeight * 0.8 ? 'start' : 'center', inline: 'nearest', behavior: 'smooth' });
    return off;
  }).catch(() => false);
  if (moved) await pause(800);
}

async function focusOn(page: Page, selector: string | null): Promise<void> {
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


/** resolve a selector in the main frame OR any child frame (Stripe's portal renders its UI in an iframe) */
function locatorInAnyFrame(page: Page, selector: string): Locator | null {
  for (const f of page.frames()) {
    try {
      const l = f.locator(selector).first();
      if (l.count()) return l;
    } catch { /* selector engine not valid in this frame */ }
  }
  return null;
}

async function clickWithPointer(page: Page, loc: Locator, force = false): Promise<void> {
  await centre(page, loc);
  const box = await loc.boundingBox();
  if (box) {
    const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
    await page.evaluate(([px, py]) => (window as unknown as DemoWindow).__demoMove(px, py), [x, y]);
    await pause(700); // the pointer's glide
    await page.evaluate(([px, py]) => (window as unknown as DemoWindow).__demoRipple(px, py), [x, y]);
  }
  // force: Stripe's portal keeps an animation layer (__sail-layer-containers) over its content that
  // intercepts pointer events forever; force skips Playwright's hit-target check and clicks anyway.
  await loc.click(force ? { force: true } : undefined);
}

/** a click at raw viewport coordinates (canvas drawing: map polygons, pin drops) */
async function clickXYWithPointer(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(([px, py]) => (window as unknown as DemoWindow).__demoMove(px, py), [x, y]);
  await pause(700);
  await page.evaluate(([px, py]) => (window as unknown as DemoWindow).__demoRipple(px, py), [x, y]);
  await page.mouse.click(x, y);
  await pause(200);
}

/**
 * Chrome's screencast sends a frame only when the screen changes; each is written with its timestamp and later
 * held on screen until the next one (ffmpeg concat with durations), then resampled to a constant frame rate.
 */
class Screencast {
  readonly #frames: Array<{ file: string; ts: number }> = [];
  // frames default to /tmp (disk); a tmpfs (e.g. /dev/shm) never stalls on disk writes under memory pressure,
  // which otherwise backs up the CDP frame queue and OOMs the renderer (seen on a swapped-out box)
  readonly #dir = mkdtempSync(join(process.env.SCREENCAST_TMPDIR ?? tmpdir(), 'screencast-'));
  #cdp?: CDPSession;
  async start(page: Page, size: { width: number; height: number }): Promise<void> {
    this.#cdp = await page.context().newCDPSession(page);
    this.#cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      const file = join(this.#dir, `f${String(this.#frames.length).padStart(6, '0')}.jpg`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      this.#frames.push({ file, ts: metadata.timestamp ?? Date.now() / 1000 });
      void this.#cdp?.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await this.#cdp.send('Page.startScreencast', { format: 'jpeg', quality: Number(process.env.SCREENCAST_QUALITY ?? 85), maxWidth: size.width, maxHeight: size.height, everyNthFrame: Number(process.env.SCREENCAST_EVERY_NTH ?? 1) });
  }
  async stop(): Promise<void> { await this.#cdp?.send('Page.stopScreencast').catch(() => {}); }
  get dir(): string { return this.#dir; }
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
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:white,fps=30:start_time=0,tpad=stop_mode=clone:stop_duration=5,format=yuv420p`,
      // start_time=0: else the video starts at the 2nd frame and runs ahead of the voice; concat also mishandles the
      // last entry's duration, so pad by cloning the last frame and cut at the recorded length
      '-t', (end - t0).toFixed(3), '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart', out]);
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

  // speech-timed: speak every line first, so each caption can hold exactly as long as its line
  const speechTimed = (tour.timing ?? 'speech') !== 'pauses' && !args.includes('--no-narrate');
  const flow = speechTimed && tour.timing === 'flow';
  let voiceFree = 0; // flow: when the line being spoken ends
  const lines = new Map<number, { file: string; d: number }>();
  if (speechTimed) {
    const voice = await Voice.load();
    const voiceDir = `${out}.voice`;
    mkdirSync(voiceDir, { recursive: true });
    for (const [i, step] of tour.steps.entries()) {
      if (!('caption' in step)) continue;
      const file = join(voiceDir, `step${i}.${voice.ext}`);
      lines.set(i, { file, d: await voice.speak(step.say ?? step.caption, file) });
    }
    const spoken = [...lines.values()].reduce((s, l) => s + l.d, 0);
    console.error(`narration: ${lines.size} lines, ${spoken.toFixed(1)} s of speech`);
  }

  const browser = await chromium.launch({ channel: process.env.DEMO_BROWSER ?? 'chrome' });
  const context = await browser.newContext({
    viewport, colorScheme: tour.colorScheme ?? 'light',
    ...(tour.geolocation ? {
      geolocation: { latitude: tour.geolocation.latitude, longitude: tour.geolocation.longitude, accuracy: tour.geolocation.accuracy ?? 20 },
      permissions: ['geolocation'],
    } : {}),
  });
  let titleText: string | null = null; // the intro title card, kept over page loads until the next caption
  await context.exposeFunction('__demoTitleText', () => titleText);
  await context.addInitScript(POINTER);
  const page = await context.newPage();
  const cast = new Screencast();
  await cast.start(page, viewport);
  const t0 = Date.now(); // the video starts here
  const cues: Array<{ t: number; say: string; caption: string; file?: string; d?: number }> = [];

  for (const [index, step] of tour.steps.entries()) {
    const kind = 'goto' in step ? 'goto ' + step.goto : 'caption' in step ? 'caption' : 'click' in step ? 'click ' + step.click : 'clickXY' in step ? 'clickXY' : 'type' in step ? 'type ' + step.type : 'fill' in step ? 'fill' : 'hover' in step ? 'hover ' + step.hover : 'press' in step ? 'press ' + step.press : Object.keys(step).join('+');
    console.error(`step ${index}: ${kind}`);
    if ('goto' in step) {
      await page.goto(new URL(step.goto, tour.base).href);
      if (step.waitFor) await page.waitForSelector(step.waitFor, { timeout: 20_000 }).catch(() => {});
    } else if ('caption' in step) {
      const line = lines.get(index);
      const titleCard = !/^https?:/.test(page.url()); // before the first goto: a title card, spoken while the app loads
      if (titleCard) {
        titleText = step.caption;
        await context.addCookies([{ name: 'demo_title', value: encodeURIComponent(step.caption), url: tour.base }]);
        await page.setContent(TITLE_CARD(step.caption));
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
      cues.push({ t: (Date.now() - t0) / 1000, caption: step.caption, say: step.say ?? step.caption, ...(line ?? {}) });
      if (!titleCard) await page.evaluate(t => (window as unknown as DemoWindow).__demoCaption(t), step.caption);
      // keep going: the next steps run under this line; the next one may start in this clip's ~0.4 s trailing silence
      if (line && flow) voiceFree = Date.now() + line.d * 1000 - 350;
      else if (line) await pause(line.d * 1000 + 150); // hold for the spoken line plus a breath, then move straight on
    } else if ('waitForVoice' in step) {
      // e.g. before a click that would change what the line describes; a number starts that many ms before it ends
      if (flow) await pause(voiceFree - Date.now() - (typeof step.waitForVoice === 'number' ? step.waitForVoice : 0));
    } else if ('focus' in step) {
      await focusOn(page, step.focus);
    } else if ('pause' in step) {
      if (!speechTimed || step.hold) await pause(step.pause); // speech-timed: only deliberate holds
    } else if ('click' in step) {
      let all: Locator = page.locator(step.click);
      if (!(await all.count())) { const hit = locatorInAnyFrame(page, step.click); if (hit) all = hit; }
      if (!(await all.count())) { if (step.optional) continue; throw new Error(`click: nothing matches ${step.click}`); }
      await clickWithPointer(page, step.last ? all.last() : all.first(), step.force);
    } else if ('clickXY' in step) {
      await clickXYWithPointer(page, step.clickXY[0], step.clickXY[1]);
    } else if ('type' in step) {
      let typeLoc: Locator = page.locator(step.type).first();
      if (!(await typeLoc.count())) { const hit = locatorInAnyFrame(page, step.type); if (hit) typeLoc = hit; }
      await clickWithPointer(page, typeLoc);
      for (const ch of step.text) { await page.keyboard.type(ch); await pause(step.delayMs ?? 110); }
    } else if ('fill' in step) {
      let fillLoc: Locator = page.locator(step.fill).first();
      if (!(await fillLoc.count())) { const hit = locatorInAnyFrame(page, step.fill); if (hit) fillLoc = hit; }
      await fillLoc.fill(step.text);
    } else if ('hover' in step) {
      let hoverLoc: Locator = page.locator(step.hover).first();
      if (!(await hoverLoc.count())) { const hit = locatorInAnyFrame(page, step.hover); if (hit) hoverLoc = hit; }
      await movePointer(page, hoverLoc);
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

  if (flow) await pause(voiceFree - Date.now() + 650); // let the last line (and its tail) finish on screen
  const end = Date.now();
  await cast.stop();
  await context.close();
  await browser.close();
  const video = `${out}.mp4`;
  cast.encode(video, t0 / 1000, end / 1000, viewport);
  // frames captured: drop them (a full /tmp tmpfs ENOSPC'd later runs; 52k stale dirs piled up over days)
  rmSync(cast.dir, { recursive: true, force: true });
  const cuesFile = `${out}.cues.json`;
  writeFileSync(cuesFile, JSON.stringify(cues, null, 2));
  console.log(video);
  if (speechTimed) {
    console.log(mixNarration(video, cues.filter((c): c is typeof c & { file: string; d: number } => !!c.file)));
  } else if (!args.includes('--no-narrate')) {
    const narrate = join(dirname(fileURLToPath(import.meta.url)), 'narrate.ts');
    console.log(execFileSync(process.execPath, [narrate, video, cuesFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim());
  }
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
