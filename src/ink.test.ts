import { describe, expect, it } from 'vitest';
import { buildInk, strokeWidths, usesRealPressure, type InkPoint, strokePath } from './ink';

type Pointer = InkPoint['pointerType'];

/** A wavy stroke of `n` points, `dt` ms apart, starting at (x0, y0). */
function wave(n: number, { x0 = 50, y0 = 80, dt = 8, step = 3, pressure = 0.5, pointerType = 'mouse' as Pointer, press }: {
  x0?: number; y0?: number; dt?: number; step?: number; pressure?: number; pointerType?: Pointer; press?: (i: number) => number;
} = {}): InkPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    x: x0 + i * step,
    y: y0 + Math.sin(i / 6) * 25,
    t: i * dt,
    pressure: press ? press(i) : pressure,
    pointerType,
  }));
}

/** Reads the numbers out of a path made of M, L and Z commands. */
function polygon(path: string): [number, number][] {
  const nums = (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
}

function distanceToPolyline(p: [number, number], line: [number, number][]) {
  let best = Infinity;
  for (let i = 0; i < line.length; i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[(i + 1) % line.length];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2));
    best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
  }
  return best;
}

describe('usesRealPressure', () => {
  it('is true for a pen whose pressure varies', () => {
    expect(usesRealPressure(wave(30, { pointerType: 'pen', press: (i) => 0.2 + (i % 10) / 20 }))).toBe(true);
  });
  it('is false for a pen that reports a constant', () => {
    expect(usesRealPressure(wave(30, { pointerType: 'pen', pressure: 0.5 }))).toBe(false);
    expect(usesRealPressure(wave(30, { pointerType: 'pen', pressure: 1 }))).toBe(false);
  });
  it('is false for a mouse or a finger even if values vary', () => {
    expect(usesRealPressure(wave(30, { pointerType: 'mouse', press: (i) => (i % 10) / 10 }))).toBe(false);
    expect(usesRealPressure(wave(30, { pointerType: 'touch', press: (i) => (i % 10) / 10 }))).toBe(false);
  });
});

describe('strokeWidths', () => {
  it('follows real pen pressure', () => {
    const w = strokeWidths(wave(30, { pointerType: 'pen', press: (i) => (i < 15 ? 0.2 : 0.9) }));
    expect(w[25]).toBeGreaterThan(w[5]);
  });
  it('makes fast movement thinner than slow movement', () => {
    const slow = wave(20, { dt: 20, step: 1 });
    const fast = wave(20, { x0: slow[19].x + 1, dt: 2, step: 12 });
    const w = strokeWidths([...slow, ...fast.map((p) => ({ ...p, t: p.t + 400 }))]);
    expect(w[8]).toBeGreaterThan(w[30]);
  });
  it('falls back to a constant when the stroke has no timing', () => {
    const w = strokeWidths(wave(20, { dt: 0 }));
    expect(new Set(w).size).toBe(1);
  });
  it('stays within 0..1', () => {
    for (const v of strokeWidths(wave(40, { dt: 1, step: 30 }))) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('strokePath', () => {
  const stroke = Array.from({ length: 12 }, (_, i) => ({ x: 50 + i * 4, y: 40, t: i * 16, pressure: 0.5, pointerType: 'mouse' as const }));

  it('gives one closed path, uncropped, for showing a stroke while it is drawn', () => {
    const path = strokePath(stroke);
    expect(path.startsWith('M')).toBe(true);
    expect(path.endsWith('Z')).toBe(true);
    expect(Number(path.slice(1).split(' ')[0])).toBeGreaterThan(40);
  });

  it('is empty for no points', () => {
    expect(strokePath([])).toBe('');
  });
});

describe('buildInk', () => {
  it('returns nothing for no ink', () => {
    expect(buildInk([])).toBeNull();
    expect(buildInk([[]])).toBeNull();
  });

  it('makes one path per stroke', () => {
    const ink = buildInk([wave(40), wave(40, { y0: 150 }), wave(40, { y0: 200 })])!;
    expect(ink.paths).toHaveLength(3);
    for (const p of ink.paths) expect(p).toMatch(/^M[^M]*Z$/);
  });

  it('crops to the ink and starts at (0,0), y down', () => {
    const ink = buildInk([wave(60, { x0: 500, y0: 900 })])!;
    const all = ink.paths.flatMap(polygon);
    expect(Math.min(...all.map((p) => p[0]))).toBeCloseTo(0, 1);
    expect(Math.min(...all.map((p) => p[1]))).toBeCloseTo(0, 1);
    expect(Math.max(...all.map((p) => p[0]))).toBeCloseTo(ink.width, 1);
    expect(Math.max(...all.map((p) => p[1]))).toBeCloseTo(ink.height, 1);
    // the wave is about 50 high and 177 wide; the tapered ends trim a little off the width
    expect(ink.width).toBeGreaterThan(150);
    expect(ink.width).toBeLessThan(200);
    expect(ink.height).toBeGreaterThan(40);
    expect(ink.height).toBeLessThan(70);
  });

  it('keeps the strokes in the same relative positions', () => {
    const ink = buildInk([wave(30, { y0: 50 }), wave(30, { y0: 250 })])!;
    const top = Math.min(...polygon(ink.paths[0]).map((p) => p[1]));
    const bottom = Math.min(...polygon(ink.paths[1]).map((p) => p[1]));
    expect(bottom - top).toBeGreaterThan(190);
    expect(bottom - top).toBeLessThan(210);
  });

  it('draws a single tap as a dot', () => {
    const ink = buildInk([[{ x: 10, y: 10, t: 0, pressure: 0.5, pointerType: 'mouse' }]])!;
    expect(ink.paths).toHaveLength(1);
    expect(ink.width).toBeGreaterThan(0);
    expect(ink.height).toBeGreaterThan(0);
  });

  it('never returns the raw points', () => {
    const stroke = wave(30, { pointerType: 'pen', press: (i) => 0.3 + (i % 7) / 10 });
    const ink = buildInk([stroke])!;
    expect(Object.keys(ink).sort()).toEqual(['height', 'paths', 'width']);
    const json = JSON.stringify(ink);
    expect(json).not.toMatch(/pressure|pointerType|"t"/);
    expect(ink.paths.every((p) => typeof p === 'string')).toBe(true);
  });

  it('makes a harder-pressed pen stroke thicker', () => {
    // pressure must vary for it to count, so both strokes ramp, one lighter than the other
    const light = buildInk([wave(40, { pointerType: 'pen', press: (i) => 0.1 + (i % 8) / 40 })], { tolerance: 0 })!;
    const hard = buildInk([wave(40, { pointerType: 'pen', press: (i) => 0.8 + (i % 8) / 40 })], { tolerance: 0 })!;
    const area = (ink: typeof light) =>
      Math.abs(polygon(ink.paths[0]).reduce((sum, [x, y], k, a) => sum + x * a[(k + 1) % a.length][1] - a[(k + 1) % a.length][0] * y, 0)) / 2;
    expect(area(hard) / area(light)).toBeGreaterThan(1.3);
  });

  describe('simplifying', () => {
    const strokes = [wave(150, { step: 2, dt: 5 }), wave(150, { y0: 160, step: 2, dt: 5 })];

    it('reduces the path data a lot', () => {
      const raw = buildInk(strokes, { tolerance: 0 })!;
      const simple = buildInk(strokes)!;
      const size = (i: typeof raw) => i.paths.join('').length;
      expect(size(simple)).toBeLessThan(size(raw) * 0.6);
    });

    it('keeps the shape within a small distance of the unsimplified outline', () => {
      const raw = buildInk(strokes, { tolerance: 0 })!;
      const simple = buildInk(strokes)!;
      expect(simple.width).toBeCloseTo(raw.width, 0);
      expect(simple.height).toBeCloseTo(raw.height, 0);
      raw.paths.forEach((rawPath, i) => {
        const a = polygon(rawPath);
        const b = polygon(simple.paths[i]);
        for (const p of a) expect(distanceToPolyline(p, b)).toBeLessThan(0.5);
        for (const p of b) expect(distanceToPolyline(p, a)).toBeLessThan(0.5);
      });
    });
  });
});
