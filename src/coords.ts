import type { Angle } from './overlay';

export interface Point {
  x: number;
  y: number;
}

export interface Box extends Point {
  width: number;
  height: number;
}

/** A page as displayed: the visible box in PDF space, turned clockwise by `rotation` degrees. */
export interface PageFrame {
  box: Box;
  rotation: number;
}

const normalize = (rotation: number) => ((rotation % 360) + 360) % 360;

/** Converts a point relative to the box (PDF points, y up) to on-screen pixels from the page's top-left. */
export function pageToView({ box, rotation }: PageFrame, zoom: number, { x, y }: Point): Point {
  const { width: w, height: h } = box;
  switch (normalize(rotation)) {
    case 90:
      return { x: y * zoom, y: x * zoom };
    case 180:
      return { x: (w - x) * zoom, y: y * zoom };
    case 270:
      return { x: (h - y) * zoom, y: (w - x) * zoom };
    default:
      return { x: x * zoom, y: (h - y) * zoom };
  }
}

/** The inverse of `pageToView`. */
export function viewToPage({ box, rotation }: PageFrame, zoom: number, view: Point): Point {
  const { width: w, height: h } = box;
  const vx = view.x / zoom;
  const vy = view.y / zoom;
  switch (normalize(rotation)) {
    case 90:
      return { x: vy, y: vx };
    case 180:
      return { x: w - vx, y: vy };
    case 270:
      return { x: w - vy, y: h - vx };
    default:
      return { x: vx, y: h - vy };
  }
}

export function displaySize({ box, rotation }: PageFrame, zoom: number) {
  const sideways = normalize(rotation) % 180 !== 0;
  return {
    width: (sideways ? box.height : box.width) * zoom,
    height: (sideways ? box.width : box.height) * zoom,
  };
}

/** Converts a point in an item's reading frame (`u` along the text, `v` downwards from its top-left) to page space. */
export function localToPage(item: Point & { angle: Angle }, u: number, v: number): Point {
  // Exact quarter turns: drawing is counter-clockwise by `angle`, which cancels the page's clockwise display rotation.
  const [cos, sin] = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] }[item.angle];
  return { x: item.x + u * cos + v * sin, y: item.y + u * sin - v * cos };
}

/** The visible part of a page: its crop box limited to the media box, which is what pdf.js displays. */
export function visibleBox(crop: Box, media: Box): Box {
  const x = Math.max(crop.x, media.x);
  const y = Math.max(crop.y, media.y);
  const width = Math.min(crop.x + crop.width, media.x + media.width) - x;
  const height = Math.min(crop.y + crop.height, media.y + media.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : media;
}
