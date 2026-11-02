import { rgb, degrees, type PDFPage } from 'pdf-lib';
import { localToPage, visibleBox } from './coords';
import type { Ink } from './ink';
import type { Angle } from './overlay';

export interface InkPlacement {
  /** The item's top-left corner as read upright, in page points relative to the visible box. */
  x: number;
  y: number;
  angle: Angle;
  w: number;
  h: number;
}

const BLACK = rgb(0, 0, 0);

/**
 * Draws cropped ink as true vector content, solid black. `drawSvgPath` measures y downwards from
 * its origin and rotates counter-clockwise by `angle`, which is exactly the item's reading frame,
 * so the origin is the item's top-left and the ink is scaled to fit the width. Each stroke is its
 * own path, so overlapping strokes cannot punch holes in each other.
 */
export function drawInk(page: PDFPage, ink: Ink, item: InkPlacement) {
  if (!ink.paths.length || ink.width <= 0) return;
  const box = visibleBox(page.getCropBox(), page.getMediaBox());
  const origin = localToPage(item, 0, 0);
  const options = { x: origin.x + box.x, y: origin.y + box.y, scale: item.w / ink.width, rotate: degrees(item.angle), color: BLACK };
  for (const path of ink.paths) page.drawSvgPath(path, options);
}
