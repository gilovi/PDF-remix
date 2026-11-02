/** Zoom is CSS pixels per PDF point. */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;
const STEP = 1.25;

/** The zoom at which a page fills the available width. */
export const fitZoom = (pageWidth: number, availableWidth: number) => availableWidth / pageWidth;

/** Limits zoom to the normal range. `fit` extends the low end, so a huge page can still fit. */
export const clampZoom = (zoom: number, fit: number) => Math.min(MAX_ZOOM, Math.max(Math.min(MIN_ZOOM, fit), zoom));

export const stepZoom = (zoom: number, direction: 1 | -1, fit: number) => clampZoom(direction > 0 ? zoom * STEP : zoom / STEP, fit);

export const pinchZoom = (startZoom: number, startDistance: number, distance: number, fit: number) =>
  clampZoom((startZoom * distance) / startDistance, fit);

/**
 * The scroll position, along one axis, that keeps the content under the pointer
 * in place. `point` is relative to the scroller, `offset` is where the page
 * starts inside it (pages smaller than the scroller are centred), and `ratio`
 * is new zoom over old zoom.
 */
export function anchoredScroll(before: { point: number; scroll: number; offset: number }, ratio: number, newOffset: number): number {
  const content = (before.scroll + before.point - before.offset) * ratio;
  return Math.max(0, content + newOffset - before.point);
}

/** The render scale closest to `wanted` that stays within the pixel limit. */
export function pixelScale(wanted: number, width: number, height: number, maxPixels: number): number {
  return Math.min(wanted, Math.sqrt(maxPixels / (width * height)));
}
