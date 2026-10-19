// The optional "polish" pass (tour key "polish", or --polish on the command line): a virtual camera, UI sounds,
// a browser-window frame, branded title and end cards, motion blur. Every feature is off unless asked for.
//   node scripts/polish.ts <out>   → re-render <out>.mp4 (+ <out>.camera.json) from <out>.raw.mp4 + <out>.track.json
// record.ts calls renderPolish right after recording. Chrome draws the still artwork (window frame, cards, captions);
// the per-frame crop, scale, blur and compositing happen here on raw RGB frames piped through ffmpeg.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright-core';
import { cameraSpeed, framedFocus, frameState, planCamera, type CameraOptions, type Rect, type Track } from './camera.ts';
import type { SoundOptions } from './sound.ts';

export interface FrameOptions { background: string; radius: number; padding: number; address: string; theme: 'light' | 'dark' }
export interface CardText { title: string; subtitle?: string; duration: number }
export interface CardOptions {
  title?: CardText; end?: CardText; brand: string; background: string; color: string; logo?: string; animation: 'fade' | 'scale' | 'none';
}
/** Captions drawn over the output (camera or frame on): text px at 1080p; auto = bottom, or top when bottom would cover the focus. */
export interface CaptionOptions { size: number; position: 'auto' | 'bottom' | 'top' }
export interface Polish { camera?: CameraOptions; sound?: SoundOptions; frame?: FrameOptions; cards?: CardOptions; blur?: { strength: number }; captions?: CaptionOptions }

const FEATURES = ['camera', 'sound', 'frame', 'cards', 'blur'];
const FPS = 30;
type Opts = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- tour JSON

/** A colour list becomes a diagonal gradient; a string is used as CSS as it is. */
const background = (v: string | string[]) => (Array.isArray(v) ? (v.length === 1 ? v[0] : `linear-gradient(135deg, ${v.join(', ')})`) : v);

/**
 * The tour's `polish` object with every default filled in; null when nothing is on. `cli` (--polish camera,sound)
 * overrides which features are on, keeping the tour's options for them; `--polish none` turns all off.
 */
export function resolvePolish(raw: Opts | undefined, cli: string | undefined, dir: string, scheme: 'light' | 'dark'): Polish | null {
  let src: Opts = raw ?? {};
  const known = (k: string) => { if (!FEATURES.includes(k)) throw new Error(`polish: unknown feature "${k}" (use ${FEATURES.join(', ')})`); };
  // captions: options for the captions drawn over the output, not a feature of its own
  const { captions: capOpts, ...features } = src;
  Object.keys(features).forEach(known);
  src = features;
  if (cli !== undefined) {
    const on = cli === 'none' ? [] : cli.split(',').map(s => s.trim()).filter(Boolean);
    on.forEach(known);
    src = Object.fromEntries(on.map(k => [k, src[k] && src[k] !== true ? src[k] : true]));
  }
  const get = (k: string): Opts | undefined => (src[k] === undefined || src[k] === false ? undefined : src[k] === true ? {} : src[k]);
  const p: Polish = {};
  const cam = get('camera');
  if (cam) p.camera = { maxZoom: cam.maxZoom ?? 1.8, padding: cam.padding ?? 40, lead: cam.lead ?? 0.15, smoothness: cam.smoothness ?? 0.7, idleZoom: cam.idleZoom ?? 1.2, wideFocus: cam.wideFocus ?? 'height' };
  const snd = get('sound');
  if (snd) p.sound = { volume: snd.volume ?? 0, duck: snd.duck ?? 7 };
  const fr = get('frame');
  if (fr) p.frame = { background: background(fr.background ?? ['#e9edf5', '#c3cde2']), radius: fr.radius ?? 14, padding: fr.padding ?? 56, address: fr.address ?? '', theme: fr.theme ?? scheme };
  const cd = get('cards');
  if (cd) {
    const brand = cd.brand ?? '#ff6b1a';
    const text = (v: unknown, d: number, sub?: string): CardText | undefined =>
      !v ? undefined : typeof v === 'string' ? { title: v, subtitle: sub, duration: d } : { title: (v as Opts).title, subtitle: (v as Opts).subtitle, duration: (v as Opts).duration ?? d };
    p.cards = {
      title: text(cd.title, cd.duration ?? 2.5, cd.subtitle), end: text(cd.end, 3), brand, color: cd.color ?? '#ffffff',
      background: background(cd.background ?? `radial-gradient(circle at 50% 38%, color-mix(in srgb, ${brand} 30%, #16181d), #0b0c0f 78%)`),
      logo: cd.logo ? resolve(dir, cd.logo) : undefined, animation: cd.animation ?? 'fade',
    };
  }
  const bl = get('blur');
  if (bl) p.blur = { strength: bl.strength ?? 1 };
  if (p.blur && !p.camera) console.error('polish: blur only acts while the camera moves; it does nothing without camera');
  if (p.camera || p.frame) {
    const c: Opts = capOpts && capOpts !== true ? capOpts : {};
    p.captions = { size: c.size ?? 36, position: c.position ?? 'auto' };
  }
  return Object.keys(p).length ? p : null;
}

/** Seconds of title card before, and end card after, the recording in <out>.mp4. */
export const cardSeconds = (p: Polish | null) => ({ title: p?.cards?.title?.duration ?? 0, end: p?.cards?.end?.duration ?? 0 });

/** Output size and where the recording sits in it: 1920×1080 in a window frame, 1080p for the camera, else as recorded. */
interface Layout { W: number; H: number; x: number; y: number; w: number; h: number; bar: number }
function layout(p: Polish, vp: { width: number; height: number }): Layout {
  const even = (v: number) => Math.round(v / 2) * 2, a = vp.width / vp.height;
  if (p.frame) {
    const W = 1920, H = 1080, bar = 40, pad = p.frame.padding;
    let w = W - 2 * pad, h = w / a;
    if (h > H - 2 * pad - bar) { h = H - 2 * pad - bar; w = h * a; }
    w = even(w); h = even(h);
    return { W, H, x: (W - w) / 2, y: Math.round((H - h - bar) / 2) + bar, w, h, bar };
  }
  const [W, H] = p.camera ? [even(1080 * a), 1080] : [vp.width - (vp.width % 2), vp.height - (vp.height % 2)];
  return { W, H, x: 0, y: 0, w: W, h: H, bar: 0 };
}

const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const FONT = '-apple-system,BlinkMacSystemFont,sans-serif';

function frameHtml(L: Layout, f: FrameOptions): string {
  const dark = f.theme === 'dark';
  const dots = ['#ff5f57', '#febc2e', '#28c840'].map(c => `<i style="width:12px;height:12px;border-radius:50%;background:${c}"></i>`).join('');
  return `<!doctype html><html><body style="margin:0;width:${L.W}px;height:${L.H}px;overflow:hidden;background:${f.background}">`
    + `<div style="position:absolute;left:${L.x}px;top:${L.y - L.bar}px;width:${L.w}px;height:${L.h + L.bar}px;border-radius:${f.radius}px;overflow:hidden;`
    + `background:${dark ? '#2b2e35' : '#eceef2'};box-shadow:0 28px 70px rgba(10,15,30,.32),0 8px 22px rgba(10,15,30,.18),0 0 0 1px rgba(0,0,0,${dark ? 0.5 : 0.08})">`
    + `<div style="height:${L.bar}px;display:flex;align-items:center;gap:8px;padding:0 16px;box-sizing:border-box;border-bottom:1px solid ${dark ? '#1d1f24' : '#d9dce1'}">${dots}`
    + `<div style="margin:0 auto;width:42%;height:26px;border-radius:7px;background:${dark ? '#1f2126' : '#fff'};color:${dark ? '#a9adb6' : '#5f6670'};`
    + `font:13px/26px ${FONT};text-align:center;white-space:nowrap;overflow:hidden">${esc(f.address)}</div><i style="width:52px"></i></div>`
    + `<div style="height:${L.h}px;background:#000"></div></div></body></html>`;
}

function cardHtml(L: Layout, c: CardOptions, t: CardText, part: 'bg' | 'fg'): string {
  const k = L.H / 1080, type = extname(c.logo ?? '').slice(1).replace('svg', 'svg+xml').replace('jpg', 'jpeg');
  const logo = c.logo ? `<img src="data:image/${type};base64,${readFileSync(c.logo).toString('base64')}" style="display:block;height:${96 * k}px;margin:0 auto ${30 * k}px">` : '';
  const body = part === 'bg' ? '' : `${logo}<div style="font-size:${76 * k}px;font-weight:700;letter-spacing:-.02em;line-height:1.1">${esc(t.title)}</div>`
    + `<div style="width:${72 * k}px;height:${6 * k}px;border-radius:${3 * k}px;background:${c.brand};margin:${26 * k}px auto 0"></div>`
    + (t.subtitle ? `<div style="margin-top:${22 * k}px;font-size:${30 * k}px;opacity:.78">${esc(t.subtitle)}</div>` : '');
  return `<!doctype html><html style="background:transparent"><body style="margin:0;width:${L.W}px;height:${L.H}px;display:grid;place-content:center;`
    + `text-align:center;font-family:${FONT};color:${c.color};background:${part === 'bg' ? c.background : 'transparent'}">${body}</body></html>`;
}

/** The recorder's caption box (record.ts), `px` text at the output's scale `u` (1 = 1080p); drawn here so the camera's
 *  zoom never crops it. */
const captionHtml = (px: number, u: number, text: string) => '<!doctype html><html style="background:transparent"><body style="margin:0">'
  + `<div id="c" style="position:fixed;left:50%;bottom:${32 * u}px;transform:translateX(-50%);max-width:84vw;width:max-content;box-sizing:border-box;text-align:center;`
  + `padding:.42em .9em;border-radius:.5em;background:rgba(20,20,20,.84);color:#fff;font:600 ${px}px/1.25 ${FONT};`
  + `box-shadow:0 ${6 * u}px ${24 * u}px rgba(0,0,0,.3)">${esc(text)}</div></body></html>`;

const decode = (png: Buffer, fmt: 'rgb24' | 'rgba') =>
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'png_pipe', '-i', '-', '-f', 'rawvideo', '-pix_fmt', fmt, '-'], { input: png, maxBuffer: 1 << 30 });

async function load(page: Page, html: string, w: number, h: number): Promise<void> {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(html, { waitUntil: 'load' });
}
async function shoot(page: Page, html: string, w: number, h: number, transparent: boolean): Promise<Buffer> {
  await load(page, html, w, h);
  return page.screenshot({ type: 'png', omitBackground: transparent });
}

interface Overlay { x: number; y: number; w: number; h: number; rgba: Buffer }
interface Card { bg: Buffer; fg: Overlay }
interface Art { frame?: Buffer; mask?: Uint8Array; captions: Map<string, Overlay>; title?: Card; end?: Card }

/** Draw the still artwork with Chrome: window frame, title/end cards, and (camera on) the captions. */
async function drawArt(p: Polish, L: Layout, track: Track, captions: string[]): Promise<Art> {
  const browser = await chromium.launch({ channel: process.env.DEMO_BROWSER ?? 'chrome' });
  const page = await (await browser.newContext({ colorScheme: track.colorScheme })).newPage();
  const art: Art = { captions: new Map() };
  try {
    if (p.frame) {
      art.frame = decode(await shoot(page, frameHtml(L, p.frame), L.W, L.H, false), 'rgb24');
      art.mask = cornerMask(L.w, L.h, p.frame.radius);
    }
    const card = async (t: CardText): Promise<Card> => {
      const fg = decode(await shoot(page, cardHtml(L, p.cards!, t, 'fg'), L.W, L.H, true), 'rgba');
      return { bg: decode(await shoot(page, cardHtml(L, p.cards!, t, 'bg'), L.W, L.H, false), 'rgb24'), fg: trim({ x: 0, y: 0, w: L.W, h: L.H, rgba: fg }) };
    };
    if (p.cards?.title) art.title = await card(p.cards.title);
    if (p.cards?.end) art.end = await card(p.cards.end);
    const u = L.H / 1080;
    for (const text of new Set(captions)) {
      await load(page, captionHtml(p.captions!.size * u, u, text), L.w, L.h);
      const r = (await page.locator('#c').boundingBox())!, m = Math.ceil(30 * u);
      const x = Math.max(0, Math.floor(r.x) - m), y = Math.max(0, Math.floor(r.y) - m);
      const clip = { x, y, width: Math.min(L.w, Math.ceil(r.x + r.width) + m) - x, height: Math.min(L.h, Math.ceil(r.y + r.height) + m) - y };
      const png = await page.screenshot({ type: 'png', omitBackground: true, clip });
      art.captions.set(text, { x, y, w: clip.width, h: clip.height, rgba: decode(png, 'rgba') });
    }
  } finally { await browser.close(); }
  return art;
}

/** Alpha of the recording in its window: rounded bottom corners (the title bar has the top ones). */
function cornerMask(w: number, h: number, r: number): Uint8Array {
  const m = new Uint8Array(w * h).fill(255);
  for (let y = h - r; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= r && x < w - r) continue;
    const cx = x < r ? r : w - r, d = Math.hypot(x + 0.5 - cx, y + 0.5 - (h - r));
    m[y * w + x] = Math.round(Math.min(1, Math.max(0, r - d + 0.5)) * 255);
  }
  return m;
}

/** A recorded frame with its half-size copies, made when a zoomed-out view needs them (sharp, not aliased). */
class Source {
  readonly levels: Array<{ px: Uint8Array; w: number; h: number }>;
  constructor(px: Uint8Array, w: number, h: number) { this.levels = [{ px, w, h }]; }
  level(l: number) {
    while (this.levels.length <= l) {
      const s = this.levels[this.levels.length - 1], w = s.w >> 1, h = s.h >> 1, px = new Uint8Array(w * h * 3);
      const sp = s.px, row = s.w * 3;
      for (let y = 0; y < h; y++) {
        let i = 2 * y * row, o = y * w * 3;
        for (let x = 0; x < w; x++, i += 6, o += 3) {
          const j = i + row;
          px[o] = (sp[i] + sp[i + 3] + sp[j] + sp[j + 3] + 2) >> 2;
          px[o + 1] = (sp[i + 1] + sp[i + 4] + sp[j + 1] + sp[j + 4] + 2) >> 2;
          px[o + 2] = (sp[i + 2] + sp[i + 5] + sp[j + 2] + sp[j + 5] + 2) >> 2;
        }
      }
      this.levels.push({ px, w, h });
    }
    return this.levels[l];
  }
}

/**
 * Add `weight` × the view (CSS px) of `src`, scaled to w×h, into `acc`; bilinear, blended between two sizes when zoomed
 * out (`blend` false: the nearer size only, for motion-blur samples where the difference can't be seen).
 */
function drawView(src: Source, dsf: number, v: Rect, acc: Float32Array, w: number, h: number, weight: number, blend = true): void {
  const s = w / ((v[2] - v[0]) * dsf); // output px per source px
  const lod = Math.max(0, Math.log2(1 / s)), l0 = Math.floor(lod), f = lod - l0;
  const parts: Array<[number, number]> = f < 0.15 || (!blend && f < 0.5) ? [[l0, 1]] : f > 0.85 || !blend ? [[l0 + 1, 1]] : [[l0, 1 - f], [l0 + 1, f]];
  for (const [l, lw] of parts) {
    const lv = src.level(l), k = dsf / 2 ** l, wt = weight * lw;
    const axis = (from: number, span: number, n: number, max: number) => {
      const i0 = new Int32Array(n), fr = new Float32Array(n);
      for (let o = 0; o < n; o++) {
        const p = Math.min(max - 1.001, Math.max(0, from * k + ((o + 0.5) * span * k) / n - 0.5));
        i0[o] = Math.floor(p); fr[o] = p - i0[o];
      }
      return { i0, fr };
    };
    const ax = axis(v[0], v[2] - v[0], w, lv.w), ay = axis(v[1], v[3] - v[1], h, lv.h), px = lv.px, row = lv.w * 3;
    for (let x = 0; x < w; x++) ax.i0[x] *= 3; // byte offsets
    for (let y = 0; y < h; y++) {
      const r0 = ay.i0[y] * row, fy = ay.fr[y];
      let o = y * w * 3;
      for (let x = 0; x < w; x++, o += 3) {
        const a = r0 + ax.i0[x], b = a + row, fx = ax.fr[x];
        const w00 = wt * (1 - fx) * (1 - fy), w10 = wt * fx * (1 - fy), w01 = wt * (1 - fx) * fy, w11 = wt * fx * fy;
        acc[o] += px[a] * w00 + px[a + 3] * w10 + px[b] * w01 + px[b + 3] * w11;
        acc[o + 1] += px[a + 1] * w00 + px[a + 4] * w10 + px[b + 1] * w01 + px[b + 4] * w11;
        acc[o + 2] += px[a + 2] * w00 + px[a + 5] * w10 + px[b + 2] * w01 + px[b + 5] * w11;
      }
    }
  }
}

/** Alpha-blend an RGBA overlay into an RGB frame of width W at (ox, oy), scaled by `s` about (cx, cy), faded by `fade`. */
function overlay(dst: Buffer, W: number, H: number, o: Overlay, ox: number, oy: number, fade = 1, s = 1, cx = 0, cy = 0): void {
  const x0 = Math.max(0, Math.floor(cx + (ox - cx) * s)), y0 = Math.max(0, Math.floor(cy + (oy - cy) * s));
  const x1 = Math.min(W, Math.ceil(cx + (ox + o.w - cx) * s)), y1 = Math.min(H, Math.ceil(cy + (oy + o.h - cy) * s)), px = o.rgba;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    // where this pixel comes from in the overlay; bilinear on premultiplied colour, so edges don't darken
    const sx = (x + 0.5 - cx) / s + cx - ox - 0.5, sy = (y + 0.5 - cy) / s + cy - oy - 0.5;
    if (sx < -0.5 || sy < -0.5 || sx > o.w - 0.5 || sy > o.h - 0.5) continue;
    const ix = Math.min(o.w - 2, Math.max(0, Math.floor(sx))), iy = Math.min(o.h - 2, Math.max(0, Math.floor(sy)));
    const fx = Math.min(1, Math.max(0, sx - ix)), fy = Math.min(1, Math.max(0, sy - iy));
    const i00 = (iy * o.w + ix) * 4, i10 = i00 + 4, i01 = i00 + o.w * 4, i11 = i01 + 4;
    const a00 = px[i00 + 3] * (1 - fx) * (1 - fy), a10 = px[i10 + 3] * fx * (1 - fy), a01 = px[i01 + 3] * (1 - fx) * fy, a11 = px[i11 + 3] * fx * fy;
    const a = ((a00 + a10 + a01 + a11) / 255) * fade;
    if (a <= 0.001) continue;
    const d = (y * W + x) * 3;
    for (let c = 0; c < 3; c++) dst[d + c] = dst[d + c] * (1 - a) + ((px[i00 + c] * a00 + px[i10 + c] * a10 + px[i01 + c] * a01 + px[i11 + c] * a11) / 255) * fade + 0.5;
  }
}

/** Cut an overlay down to its visible pixels (a full-screen card text layer is mostly transparent). */
function trim(o: Overlay): Overlay {
  let x0 = o.w, y0 = o.h, x1 = 0, y1 = 0;
  for (let y = 0; y < o.h; y++) for (let x = 0; x < o.w; x++) if (o.rgba[(y * o.w + x) * 4 + 3]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1); }
  if (x1 - x0 < 2 || y1 - y0 < 2) return o;
  const w = x1 - x0, h = y1 - y0, rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) o.rgba.copy(rgba, y * w * 4, ((y + y0) * o.w + x0) * 4, ((y + y0) * o.w + x1) * 4);
  return { x: o.x + x0, y: o.y + y0, w, h, rgba };
}

/** Same picture: the intermediate's encoder leaves ±1–2 levels of noise on a still screen, invisible either way. */
function sameFrame(a: Buffer, b: Buffer): boolean {
  if (a.equals(b)) return true;
  for (let i = 0; i < a.length; i++) if (a[i] - b[i] > 2 || b[i] - a[i] > 2) return false;
  return true;
}

const ease = (u: number) => { u = Math.min(1, Math.max(0, u)); return u * u * (3 - 2 * u); };
const mix = (a: Buffer, b: Buffer, w: number) => { const o = Buffer.allocUnsafe(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] + (b[i] - a[i]) * w; return o; };

/** Frames of a title or end card: the background, the text fading (and maybe scaling) in. */
function cardFrame(c: Card, L: Layout, anim: CardOptions['animation'], t: number, delay: number): Buffer {
  const out = Buffer.from(c.bg), e = anim === 'none' ? 1 : ease((t - delay) / 0.7);
  overlay(out, L.W, L.H, c.fg, c.fg.x, c.fg.y, e, anim === 'scale' ? 0.92 + 0.08 * e : 1, L.W / 2, L.H / 2);
  return out;
}

/** Read raw RGB frames from a video, one Buffer per frame. */
async function* frames(file: string, w: number, h: number): AsyncGenerator<Buffer> {
  const dec = spawn('ffmpeg', ['-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const size = w * h * 3;
  let buf = Buffer.allocUnsafe(size), at = 0;
  for await (const chunk of dec.stdout as AsyncIterable<Buffer>) {
    for (let off = 0; off < chunk.length;) {
      const n = Math.min(size - at, chunk.length - off);
      chunk.copy(buf, at, off, off + n); at += n; off += n;
      if (at === size) { yield buf; buf = Buffer.allocUnsafe(size); at = 0; }
    }
  }
}

const probe = (file: string) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' })
  .trim().split(',').map(Number);

/** Render <out>.mp4 from <out>.raw.mp4 and <out>.track.json; also writes <out>.camera.json (for check.ts and tighten.ts). */
export async function renderPolish(out: string): Promise<string> {
  const track = JSON.parse(readFileSync(`${out}.track.json`, 'utf8')) as Track;
  const p = track.polish as Polish, vp = track.viewport, L = layout(p, vp), raw = `${out}.raw.mp4`;
  if (p.camera && !p.captions) p.captions = { size: 36, position: 'auto' }; // a track from before caption options
  const [sw, sh] = probe(raw), n = Math.max(1, Math.round(track.duration * FPS));

  const fr = frameState(track, n, FPS);
  const full: Rect = [0, 0, vp.width, vp.height];
  const views = p.camera ? planCamera(fr, vp.width, vp.height, p.camera, FPS) : fr.wide.map(() => full);
  const focus = p.camera ? framedFocus(fr, vp.width, vp.height, p.camera) : fr.focus; // what the camera frames of each
  const speed = p.blur && p.camera ? cameraSpeed(views, L.w / vp.width, vp.width).map(v => v * p.blur!.strength) : [];
  // captions: drawn over the output when the camera or frame is on (in the page they would be zoomed and cropped, or
  // scaled with the page); each one shows until the next caption or page load, as in the page
  const caps = p.captions ? track.events.filter(e => e.type === 'caption' && !e.card) : [];
  const ends = track.events.filter(e => e.type === 'caption' || e.type === 'goto' || e.type === 'doc').map(e => e.t);
  const shown = caps.map(c => ({ text: c.text!, from: c.t, to: Math.min(...ends.filter(t => t > c.t), Infinity), top: p.captions!.position === 'top' }));
  const art = await drawArt(p, L, track, shown.map(c => c.text));
  if (p.captions?.position === 'auto') {
    // bottom, unless the box there would cover the focus or pointer (as seen through the camera) more than at the top
    for (const c of shown) {
      const o = art.captions.get(c.text)!, covered = (y0: number) => {
        let sum = 0;
        for (let k = Math.max(0, Math.round(c.from * FPS)); k < Math.min(n, Math.round(c.to * FPS)); k++) {
          const v = views[k], sx = L.w / (v[2] - v[0]), sy = L.h / (v[3] - v[1]), ptr = fr.pointer[k];
          for (const r of [focus[k], ptr && [ptr[0] - 4, ptr[1] - 4, ptr[0] + 24, ptr[1] + 24]]) {
            if (!r) continue;
            const x0 = (r[0] - v[0]) * sx, x1 = (r[2] - v[0]) * sx, y1a = (r[1] - v[1]) * sy, y1b = (r[3] - v[1]) * sy;
            sum += Math.max(0, Math.min(x1, o.x + o.w) - Math.max(x0, o.x)) * Math.max(0, Math.min(y1b, y0 + o.h) - Math.max(y1a, y0));
          }
        }
        return sum;
      };
      c.top = covered(o.y) > 0 && covered(L.h - o.y - o.h) < covered(o.y);
    }
  }

  const file = `${out}.mp4`;
  const enc = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${L.W}x${L.H}`, '-r', String(FPS), '-probesize', '32', '-i', 'pipe:0',
    '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { stdio: ['pipe', 'inherit', 'inherit'] });
  const write = async (b: Buffer) => { if (!enc.stdin.write(b)) await once(enc.stdin, 'drain'); };
  const cards = p.cards!, T = cardSeconds(p);

  const acc = new Float32Array(L.w * L.h * 3);
  let prev: { src: Buffer; v: Rect; cap?: (typeof shown)[number]; out: Buffer } | undefined, i = 0, drawn = 0, last: Buffer | undefined;
  for await (const src of frames(raw, sw, sh)) {
    const k = Math.min(i, n - 1), v = views[k], t = i / FPS, cap = shown.find(c => t >= c.from && t < c.to);
    const moving = (speed[k] ?? 0) > 2;
    let frame: Buffer;
    if (prev && !moving && cap === prev.cap && v.every((x, c) => x === prev!.v[c]) && sameFrame(src, prev.src)) frame = prev.out; // a hold: nothing changed
    else {
      drawn++;
      acc.fill(0);
      const source = new Source(src, sw, sh);
      // motion blur: the camera's own movement over half a frame (a 180° shutter), samples ≤ 2 px apart
      const steps = moving ? Math.min(6, Math.ceil((speed[k] * 0.5) / 2) + 1) : 1;
      for (let s = 0; s < steps; s++) {
        const u = steps === 1 ? 0 : -0.25 + (0.5 * s) / (steps - 1), j = u < 0 ? k - 1 : k + 1, nb = views[Math.max(0, Math.min(n - 1, j))];
        drawView(source, track.dsf, v.map((x, c) => x + (nb[c] - x) * Math.abs(u)) as Rect, acc, L.w, L.h, 1 / steps, steps === 1);
      }
      frame = art.frame ? Buffer.from(art.frame) : Buffer.allocUnsafe(L.W * L.H * 3);
      for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
        const a = art.mask ? art.mask[y * L.w + x] / 255 : 1, o = ((y + L.y) * L.W + x + L.x) * 3, q = (y * L.w + x) * 3;
        for (let c = 0; c < 3; c++) frame[o + c] = a === 1 ? acc[q + c] + 0.5 : frame[o + c] * (1 - a) + acc[q + c] * a + 0.5;
      }
      if (cap) { const o = art.captions.get(cap.text)!; overlay(frame, L.W, L.H, o, L.x + o.x, L.y + (cap.top ? L.h - o.y - o.h : o.y)); }
    }
    if (frame !== prev?.out) prev = { src, v, cap, out: frame }; // compare with the frame drawn, so noise can't creep
    if (i === 0 && art.title) { // the title card, cross-fading into the first frame
      for (let j = 0; j < Math.round(T.title * FPS); j++) {
        const tt = j / FPS, c = cardFrame(art.title, L, cards.animation, tt, 0.15);
        await write(mix(c, frame, ease((tt - (T.title - 0.45)) / 0.45)));
      }
    }
    await write(frame);
    last = frame; i++;
  }
  if (art.end && last) { // the end card, cross-fading in from the last frame, then fading to black
    for (let j = 0; j < Math.round(T.end * FPS); j++) {
      const tt = j / FPS, c = mix(last, cardFrame(art.end, L, cards.animation, tt, 0.35), ease(tt / 0.45));
      await write(mix(Buffer.alloc(c.length), c, ease((T.end - tt) / 0.5)));
    }
  }
  enc.stdin.end();
  if (process.env.POLISH_DEBUG) console.error(`polish: drew ${drawn} of ${i} frames (the rest were holds)`);
  const [code] = await once(enc, 'close');
  if (code !== 0) throw new Error(`ffmpeg failed encoding ${file}`);

  // the camera per output frame (null on cards), with what it had to show, for check.ts and tighten.ts
  const r = (x: number) => Math.round(x * 10) / 10, round = (v: Rect | [number, number] | null) => v && v.map(r);
  const pad = (k: number) => Array(Math.round(k * FPS)).fill(null);
  writeFileSync(`${out}.camera.json`, JSON.stringify({
    fps: FPS, size: [L.W, L.H], content: [L.x, L.y, L.w, L.h], viewport: [vp.width, vp.height], offset: T.title, camera: !!p.camera,
    frames: [...pad(T.title), ...Array.from({ length: i }, (_, j) => Math.min(j, n - 1)).map(k => ({ v: round(views[k]), f: round(focus[k]), p: round(fr.pointer[k]), w: fr.wide[k] || undefined })), ...(art.end ? pad(T.end) : [])],
  }));
  return file;
}

// run only as a script; record.ts imports renderPolish
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const out = process.argv[2]?.replace(/\.mp4$/, '');
  if (!out) { console.error('usage: node scripts/polish.ts <out base, e.g. out/my-demo>'); process.exit(1); }
  renderPolish(resolve(out)).then(f => console.log(f), e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
