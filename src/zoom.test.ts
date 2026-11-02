import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, anchoredScroll, clampZoom, fitZoom, pinchZoom, pixelScale, stepZoom } from './zoom';

describe('fitZoom', () => {
  it('fits the page to the available width', () => {
    expect(fitZoom(500, 1000)).toBe(2);
  });
});

describe('clampZoom', () => {
  it('limits zoom to the normal range', () => {
    expect(clampZoom(100, 1)).toBe(MAX_ZOOM);
    expect(clampZoom(0.01, 1)).toBe(MIN_ZOOM);
  });

  it('lets a huge page go below the minimum, so it can still fit', () => {
    expect(clampZoom(0.01, 0.2)).toBe(0.2);
  });
});

describe('stepZoom', () => {
  it('moves in and out by a constant factor, so a step in then out returns', () => {
    expect(stepZoom(stepZoom(1, 1, 1), -1, 1)).toBeCloseTo(1);
    expect(stepZoom(1, 1, 1)).toBeGreaterThan(1);
  });

  it('stops at the limits', () => {
    expect(stepZoom(MAX_ZOOM, 1, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1, 1)).toBe(MIN_ZOOM);
  });
});

describe('pinchZoom', () => {
  it('scales with the distance between the fingers, within the limits', () => {
    expect(pinchZoom(1, 100, 200, 1)).toBe(2);
    expect(pinchZoom(1, 100, 10000, 1)).toBe(MAX_ZOOM);
  });
});

describe('anchoredScroll', () => {
  it('keeps the content under the pointer in place', () => {
    const before = { point: 300, scroll: 100, offset: 50 };
    const after = anchoredScroll(before, 2, 20);
    // Content under the pointer before: (100 + 300 - 50) = 350 at the old zoom, 700 at the new.
    expect(after + before.point - 20).toBe(700);
  });

  it('never returns a negative scroll', () => {
    expect(anchoredScroll({ point: 300, scroll: 0, offset: 200 }, 0.5, 200)).toBe(0);
  });
});

describe('pixelScale', () => {
  it('uses the wanted scale while it fits the limit', () => {
    expect(pixelScale(2, 100, 100, 1_000_000)).toBe(2);
  });

  it('caps the scale so a render never exceeds the pixel limit', () => {
    const scale = pixelScale(10, 1000, 1000, 16_000_000);
    expect(scale).toBeCloseTo(4);
    expect(scale * 1000 * (scale * 1000)).toBeLessThanOrEqual(16_000_000);
  });
});
