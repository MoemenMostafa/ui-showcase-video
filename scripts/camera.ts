// Virtual camera for the "polish" option: plan a smooth crop path over a recording from its track (pointer, focus
// mark, page loads, spoken lines). Pure functions: scripts/polish.ts renders the path, scripts/check.ts verifies it.
// The path is a series of still shots (what must be seen, framed with padding), switched only when something leaves
// the frame, the focus moves on, or the zoom is far off; each switch is eased in ahead of the action with a
// raised-cosine blend (no linear pans), and a last pass widens the view smoothly wherever the focus or pointer
// would otherwise be cut off.

/** x0, y0, x1, y1 in CSS px of the recorded viewport. */
export type Rect = [number, number, number, number];

/** One in-page sample (scripts/record.ts): pointer tip, focus mark (with its 6 px frame), intro card showing. */
export interface Sample { t: number; p?: [number, number]; f?: Rect; card?: boolean }

/** What the recorder did, in seconds on the recording's timeline. */
export interface TrackEvent {
  type: 'goto' | 'doc' | 'click' | 'key' | 'caption' | 'scroll' | 'still' | 'focus';
  t: number;
  end?: number; // goto, scroll, still
  x?: number; y?: number; // click
  text?: string; d?: number; card?: boolean; // caption: its text, when its voice ends (s after t), shown as the intro card
}

/** <out>.track.json, written by record.ts when any polish feature is on. */
export interface Track {
  viewport: { width: number; height: number };
  dsf: number; // device scale factor of <out>.raw.mp4
  duration: number; // s, of <out>.raw.mp4
  offset: number; // s of title card before the recording in <out>.mp4
  endCard: number; // s of end card after it
  colorScheme: 'light' | 'dark';
  polish: unknown; // the resolved options (scripts/polish.ts Polish)
  samples: Sample[];
  events: TrackEvent[];
}

/** wideFocus: a focus area much wider than the view's aspect is framed on its full width ("fit", often barely zoomed) or
 *  on its height ("height"): zoomed for reading, showing the part around the pointer (or its middle). */
export interface CameraOptions { maxZoom: number; padding: number; lead: number; smoothness: number; idleZoom: number; wideFocus: 'fit' | 'height' }

/** The track resampled to one entry per video frame. */
export interface Frames {
  focus: Array<Rect | null>;
  pointer: Array<[number, number] | null>;
  wide: boolean[]; // full view: intro card, page loads, `"camera": false` steps
  speaking: boolean[]; // a line is being spoken: hold still unless something would be cut off
  scrolling: boolean[]; // the page scrolls under a fixed camera: the old focus is on its way out, ignore it
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const union = (a: Rect | null, b: Rect | null): Rect | null =>
  !a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const grow = (r: Rect | null, by: number): Rect | null => r && [r[0] - by, r[1] - by, r[2] + by, r[3] + by];
const clip = (r: Rect | null, w: number, h: number): Rect | null => {
  if (!r) return null;
  const c: Rect = [clamp(r[0], 0, w), clamp(r[1], 0, h), clamp(r[2], 0, w), clamp(r[3], 0, h)];
  return c[2] - c[0] < 1 || c[3] - c[1] < 1 ? null : c;
};
export const inside = (r: Rect, v: Rect, tol = 0.5) => r[0] >= v[0] - tol && r[1] >= v[1] - tol && r[2] <= v[2] + tol && r[3] <= v[3] + tol;
/** Same area: the focus moved on when the overlap drops below 60%. */
function same(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const area = (r: Rect) => (r[2] - r[0]) * (r[3] - r[1]);
  return (ix * iy) / (area(a) + area(b) - ix * iy) > 0.6;
}
/** The pointer's tip plus its arrow and the click ripple around it. */
const pointerBox = (p: [number, number] | null): Rect | null => p && [p[0] - 30, p[1] - 30, p[0] + 42, p[1] + 42];

/** Resample the in-page samples and the recorder's events to `n` frames at `fps`. */
export function frameState(track: Track, n: number, fps: number): Frames {
  const samples = [...track.samples].sort((a, b) => a.t - b.t);
  const during = (type: TrackEvent['type'], t: number, before = 0, after = 0) =>
    track.events.some(e => e.type === type && t >= e.t - before && t <= (e.end ?? e.t) + after);
  const fr: Frames = { focus: [], pointer: [], wide: [], speaking: [], scrolling: [] };
  let k = -1;
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    while (k + 1 < samples.length && samples[k + 1].t <= t) k++;
    const s = samples[k];
    fr.focus.push(s?.f ?? null);
    fr.pointer.push(s?.p ?? null);
    // no sample yet (title card page) counts as the full view; so do page loads, until the new page has settled
    fr.wide.push(!s || !!s.card || during('goto', t, 0.05, 0.5) || during('doc', t, 0, 0.6) || during('still', t));
    fr.speaking.push(track.events.some(e => e.type === 'caption' && !e.card && e.d !== undefined && t >= e.t && t <= e.t + e.d));
    fr.scrolling.push(during('scroll', t));
  }
  // the recorder moves the mark only after scrolling to its new target, just before the line; but attention moves on
  // when it starts (a 'focus' event): from then on the focus is where the new one lands, so the camera can get there first
  for (const e of track.events.filter(e => e.type === 'focus')) {
    const a = Math.round(e.t * fps);
    if (a >= n) continue;
    let b = a;
    while (b < Math.min(n, a + 2 * fps) && same(fr.focus[b], fr.focus[a])) b++;
    if (b >= n || b === a + 2 * fps || same(fr.focus[b], fr.focus[a])) continue; // no change (same mark again)
    for (let i = a; i < b; i++) fr.focus[i] = fr.focus[b];
  }
  return fr;
}

/**
 * The part of each focus area the camera frames. wideFocus "height": a focus more than 1.5× wider than the view's aspect
 * is framed on its height (zoom up to maxZoom) and cut to the width that zoom shows, around where the pointer is while
 * that focus lasts (else its middle); one place per focus, so the camera doesn't wander with the pointer.
 */
export function framedFocus(fr: Frames, W: number, H: number, o: CameraOptions): Array<Rect | null> {
  if (o.wideFocus !== 'height') return fr.focus;
  const out = [...fr.focus], n = out.length;
  for (let a = 0; a < n;) {
    let b = a + 1;
    while (b < n && same(fr.focus[b], fr.focus[a])) b++;
    const f = fr.focus[a];
    if (f) {
      const fw = f[2] - f[0], fh = f[3] - f[1], z = clamp(H / (fh + 2 * o.padding), 1, Math.max(1, o.maxZoom)), w = W / z - 2 * o.padding;
      if (fw / fh > 1.5 * (W / H) && w < fw) {
        // where along the focus the pointer is (as a share of its width, so it follows a scroll), median over the focus
        const at = fr.pointer.slice(a, b).map((p, j) => { const r = fr.focus[a + j]; return p && r && p[0] >= r[0] && p[0] <= r[2] ? (p[0] - r[0]) / (r[2] - r[0]) : null; })
          .filter((x): x is number => x !== null).sort((x, y) => x - y);
        const u = at.length > (b - a) / 3 ? at[at.length >> 1] : 0.5;
        for (let i = a; i < b; i++) {
          const r = fr.focus[i]!, cx = clamp(r[0] + u * (r[2] - r[0]), r[0] + w / 2, r[2] - w / 2);
          out[i] = [cx - w / 2, r[1], cx + w / 2, r[3]];
        }
      }
    }
    a = b;
  }
  return out;
}

/** The view of size `w` (and the viewport's aspect) centred on cx, cy, kept inside the page. */
function around(cx: number, cy: number, w: number, W: number, H: number): Rect {
  w = Math.min(w, W);
  const h = (w * H) / W, x = clamp(cx - w / 2, 0, W - w), y = clamp(cy - h / 2, 0, H - h);
  return [x, y, x + w, y + h];
}
/** The tightest view (zoom 1…maxZoom) that shows `r`, centred on it; moved flush with the page's edge when it would
 *  otherwise leave a thin sliver (under 8% of the view) of the page beyond it. */
function fit(r: Rect, W: number, H: number, maxZoom: number): Rect {
  const z = clamp(Math.min(W / (r[2] - r[0]), H / (r[3] - r[1])), 1, Math.max(1, maxZoom));
  const v = around((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, W / z, W, H);
  // [lo, hi) of the view on one axis of length max, [r0, r1) of what it must show: how far to move it to the edge
  const snap = (lo: number, hi: number, max: number, r0: number, r1: number) => {
    const size = hi - lo;
    if (lo > 0 && lo < 0.08 * size && r1 <= size) return -lo;
    if (hi < max && max - hi < 0.08 * size && r0 >= max - size) return max - hi;
    return 0;
  };
  const dx = snap(v[0], v[2], W, r[0], r[2]), dy = snap(v[1], v[3], H, r[1], r[3]);
  return [v[0] + dx, v[1] + dy, v[2] + dx, v[3] + dy];
}
const zoomOf = (v: Rect, W: number) => W / (v[2] - v[0]);

/** Plan the camera: one view per frame (CSS px of the viewport). */
export function planCamera(fr: Frames, W: number, H: number, o: CameraOptions, fps: number): Rect[] {
  const n = fr.wide.length, full: Rect = [0, 0, W, H];
  if (!n) return [];
  fr = { ...fr, focus: framedFocus(fr, W, H, o) };
  // need: what a shot frames (the focus with padding, and the pointer); while the page scrolls the old focus is on
  // its way out, so a shot ignores it — must: what is never cut off (the focus itself and the pointer), even then
  const need = (i: number, pad: number): Rect | null =>
    fr.wide[i] ? null : clip(union(fr.scrolling[i] ? null : grow(fr.focus[i], pad), pointerBox(fr.pointer[i])), W, H);
  const must = (i: number): Rect | null => (fr.wide[i] ? null : clip(union(grow(fr.focus[i], 2), pointerBox(fr.pointer[i])), W, H));
  const look = Math.round(0.8 * fps); // a new shot also covers what happens in the next 0.8 s (e.g. a pointer glide)
  const desired = (i: number, until = i + look): Rect => {
    if (fr.wide[i]) return full;
    let r = need(i, o.padding);
    for (let j = i + 1; j < Math.min(n, until) && !fr.wide[j] && same(fr.focus[j], fr.focus[i]); j++) r = union(r, need(j, o.padding));
    // nothing marked: follow the pointer gently, at a low zoom
    return r ? fit(r, W, H, fr.focus[i] && !fr.scrolling[i] ? o.maxZoom : o.idleZoom) : full;
  };

  // 1. still shots, switched only when needed
  const shots: Rect[] = [];
  let cur = desired(0), shotFocus = fr.focus[0], since = 0;
  const minShot = Math.round(0.5 * fps), settle = Math.round(0.3 * fps);
  const zoomOff = (i: number) => { const r = zoomOf(desired(i), W) / zoomOf(cur, W); return r > 1.15 || r < 1 / 1.15; };
  const lineEnd = (i: number) => { let j = i; while (j < n && fr.speaking[j]) j++; return j; };
  for (let i = 0; i < n; i++) {
    const m = must(i);
    let cut = (i > 0 && fr.wide[i] !== fr.wide[i - 1]) || (!!m && !inside(m, cur)); // page load, or something would be cut off
    // a line starts: frame all it needs until it ends, so the move is over before the voice and nothing moves under it
    if (!cut && !fr.wide[i] && fr.speaking[i] && !fr.speaking[i - 1]) {
      const d = desired(i, lineEnd(i)), z = zoomOf(d, W) / zoomOf(cur, W), dc = Math.hypot(d[0] + d[2] - cur[0] - cur[2], d[1] + d[3] - cur[1] - cur[3]) / 2;
      if (z > 1.1 || z < 1 / 1.1 || dc > 0.05 * (cur[2] - cur[0])) { cur = d; shotFocus = fr.focus[i]; since = i; shots.push(cur); continue; }
    }
    if (!cut && !fr.wide[i] && i - since >= minShot) {
      const later = Math.min(n - 1, i + settle);
      // the focus moved on (and stays moved), or the zoom is far off for a while — but never while a line is spoken
      if (!fr.scrolling[i] && !same(fr.focus[i], shotFocus) && !same(fr.focus[later], shotFocus)) cut = true;
      else if (!fr.speaking[i] && !fr.scrolling[i] && zoomOff(i) && zoomOff(later)) cut = true;
    }
    if (cut) { cur = desired(i); shotFocus = fr.focus[i]; since = i; }
    shots.push(cur);
  }

  // 2. ease between shots: a raised-cosine blend `smoothness` s long, shifted so each move ends `lead` s before its cut —
  //    but a move never starts while a line is still being spoken
  const half = Math.max(1, Math.round((o.smoothness * fps) / 2)), shift = Math.round(o.lead * fps) + half;
  const cuts: Array<{ at: number; v: Rect }> = [{ at: 0, v: shots[0] }];
  for (let i = 1; i < n; i++) {
    if (shots[i] === shots[i - 1]) continue;
    let at = i - shift; // where the blend is centred
    for (let j = Math.max(0, at - half); j < Math.min(n, at + half); j++) {
      if (!fr.speaking[j]) continue;
      at = Math.max(at, lineEnd(j) + half);
      break;
    }
    while (cuts.length > 1 && cuts[cuts.length - 1].at >= at) cuts.pop(); // overtaken by this one
    cuts.push({ at: Math.max(at, cuts[cuts.length - 1].at + 1), v: shots[i] });
  }
  const timed: Rect[] = [];
  cuts.forEach((c, k) => { for (let i = c.at; i < (cuts[k + 1]?.at ?? n + shift + half); i++) timed.push(c.v); });
  const kernel = Array.from({ length: 2 * half + 1 }, (_, j) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (j + 1)) / (2 * half + 2)));
  const ksum = kernel.reduce((a, b) => a + b, 0);
  const path: Rect[] = shots.map((_, i) => {
    const v: Rect = [0, 0, 0, 0];
    kernel.forEach((k, j) => { const s = timed[clamp(i + j - half, 0, timed.length - 1)]; for (let c = 0; c < 4; c++) v[c] += (k / ksum) * s[c]; });
    return v;
  });

  // 3. never cut off the focus or the pointer: widen each side by what it misses, spread smoothly over ±0.2 s
  //    (a moving max, then a moving average no wider than it, so the widening is never less than needed)
  const r = Math.round(0.2 * fps), miss: number[][] = [[], [], [], []];
  path.forEach((v, i) => {
    const m = must(i);
    [m ? v[0] - m[0] : 0, m ? v[1] - m[1] : 0, m ? m[2] - v[2] : 0, m ? m[3] - v[3] : 0].forEach((e, c) => miss[c].push(Math.max(0, e)));
  });
  const smooth = miss.map(side => {
    const mx = side.map((_, i) => Math.max(...side.slice(Math.max(0, i - r), i + r + 1)));
    return mx.map((_, i) => { const w = mx.slice(Math.max(0, i - r), i + r + 1); return w.reduce((a, b) => a + b, 0) / w.length; });
  });
  return path.map((v, i) => {
    let [x0, y0, x1, y1] = [v[0] - smooth[0][i], v[1] - smooth[1][i], v[2] + smooth[2][i], v[3] + smooth[3][i]];
    // back to the viewport's aspect by growing the short side, then inside the page
    if ((x1 - x0) / (y1 - y0) < W / H) { const w = ((y1 - y0) * W) / H; x0 -= (w - (x1 - x0)) / 2; x1 = x0 + w; }
    else { const h = ((x1 - x0) * H) / W; y0 -= (h - (y1 - y0)) / 2; y1 = y0 + h; }
    if (x1 - x0 >= W) return full;
    const dx = x0 < 0 ? -x0 : x1 > W ? W - x1 : 0, dy = y0 < 0 ? -y0 : y1 > H ? H - y1 : 0;
    return [x0 + dx, y0 + dy, x1 + dx, y1 + dy];
  });
}

/** How far the view moves per frame, in output px (`scale` = output px per CSS px at zoom 1). */
export function cameraSpeed(path: Array<Rect | null>, scale: number, W: number): number[] {
  return path.map((v, i) => {
    const a = path[i - 1] ?? v, b = path[i + 1] ?? v;
    if (!v || !a || !b) return 0;
    const z = zoomOf(v, W) * scale; // output px per CSS px in this frame
    return (Math.max(...[0, 1, 2, 3].map(c => Math.abs(b[c] - a[c]))) / 2) * z;
  });
}
