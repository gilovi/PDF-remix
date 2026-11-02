import { getStroke } from 'perfect-freehand';

export interface InkPoint {
  x: number;
  y: number;
  /** Milliseconds, from `PointerEvent.timeStamp`. */
  t: number;
  pressure: number;
  pointerType: 'pen' | 'mouse' | 'touch';
}

/** A signature cropped to its ink: one filled outline per stroke, y down, starting at (0,0). */
export interface Ink {
  paths: string[];
  width: number;
  height: number;
}

export interface InkOptions {
  /** Pen diameter at full width, in the pad's units. */
  size?: number;
  /** How far, at most, simplifying may move the outline. 0 keeps every point. */
  tolerance?: number;
}

type Vec2 = [number, number];

const SPEED_WINDOW = 2;
const DECIMALS = 100;

/** A pen reporting pressure that actually changes. Some devices send a constant, which would give a flat line. */
export function usesRealPressure(stroke: readonly InkPoint[]): boolean {
  if (!stroke.length || stroke.some((p) => p.pointerType !== 'pen')) return false;
  const values = stroke.map((p) => p.pressure);
  return Math.max(...values) - Math.min(...values) > 0.05;
}

/**
 * One width factor (0..1) per point. Real pen pressure when it varies; otherwise derived from
 * speed over a small window, so fast is thin and slow is thick.
 */
export function strokeWidths(stroke: readonly InkPoint[]): number[] {
  if (usesRealPressure(stroke)) return stroke.map((p) => Math.min(1, Math.max(0, p.pressure)));
  const elapsed = stroke.length ? stroke[stroke.length - 1].t - stroke[0].t : 0;
  if (elapsed <= 0) return stroke.map(() => 0.5);

  const widths: number[] = [];
  let smoothed = 0.9;
  stroke.forEach((_, i) => {
    const from = Math.max(0, i - SPEED_WINDOW);
    const to = Math.min(stroke.length - 1, i + SPEED_WINDOW);
    let length = 0;
    for (let j = from + 1; j <= to; j++) length += Math.hypot(stroke[j].x - stroke[j - 1].x, stroke[j].y - stroke[j - 1].y);
    const speed = length / Math.max(1, stroke[to].t - stroke[from].t);
    const target = 0.15 + 0.75 * Math.exp(-speed / 1.2);
    smoothed = i === 0 ? target : smoothed + (target - smoothed) * 0.35;
    widths.push(smoothed);
  });
  return widths;
}

/** Ramer-Douglas-Peucker on a closed ring, so no point of the original is further than `tolerance` from the result. */
export function simplifyRing(ring: Vec2[], tolerance: number): Vec2[] {
  if (tolerance <= 0 || ring.length < 4) return ring;
  const line = [...ring, ring[0]];
  const keep = new Array<boolean>(line.length).fill(false);
  keep[0] = keep[line.length - 1] = true;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = line[a];
    const dx = line[b][0] - ax;
    const dy = line[b][1] - ay;
    const len = Math.hypot(dx, dy);
    let far = -1;
    let farDistance = tolerance;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = line[i];
      const d = len === 0 ? Math.hypot(px - ax, py - ay) : Math.abs((px - ax) * dy - (py - ay) * dx) / len;
      if (d > farDistance) {
        far = i;
        farDistance = d;
      }
    }
    if (far >= 0) {
      keep[far] = true;
      stack.push([a, far], [far, b]);
    }
  }
  return line.slice(0, -1).filter((_, i) => keep[i]);
}

function outline(stroke: readonly InkPoint[], size: number): Vec2[] {
  const widths = strokeWidths(stroke);
  return getStroke(
    stroke.map((p, i) => [p.x, p.y, widths[i]]),
    {
      size,
      thinning: 0.6,
      smoothing: 0.6,
      streamline: 0.5,
      simulatePressure: false,
      start: { taper: size * 2, cap: true },
      end: { taper: size * 4, cap: true },
      last: true,
    },
  ) as Vec2[];
}

const round = (n: number) => Math.round(n * DECIMALS) / DECIMALS;

/** Turns captured strokes into cropped vector ink. Returns null when there is nothing to draw. */
export function buildInk(strokes: readonly (readonly InkPoint[])[], { size = 3.2, tolerance = 0.3 }: InkOptions = {}): Ink | null {
  const rings = strokes
    .filter((s) => s.length)
    .map((s) => simplifyRing(outline(s, size), tolerance))
    .filter((r) => r.length >= 3);
  if (!rings.length) return null;

  const all = rings.flat();
  const minX = Math.min(...all.map((p) => p[0]));
  const minY = Math.min(...all.map((p) => p[1]));
  const maxX = Math.max(...all.map((p) => p[0]));
  const maxY = Math.max(...all.map((p) => p[1]));

  const paths = rings.map(
    (ring) =>
      'M' + ring.map(([x, y], i) => `${i === 1 ? 'L' : ''}${round(x - minX)} ${round(y - minY)}`).join(' ') + 'Z',
  );
  return { paths, width: round(maxX - minX), height: round(maxY - minY) };
}
