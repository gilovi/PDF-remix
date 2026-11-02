import { displaySize, pageToView, type PageFrame } from './coords';
import type { Ink } from './ink';
import type { Overlay } from './overlay';
import type { PDFDocumentProxy } from './render';

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const SVG = 'http://www.w3.org/2000/svg';

/** Looks up what signatures need for drawing, by asset id. */
export interface ItemAssets {
  imageUrl(assetId: string): string | undefined;
  ink(assetId: string): Ink | undefined;
}

/** Draws vector ink on screen, from the same paths the PDF gets. */
export function inkSvg(ink: Ink, width?: number, height?: number): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${ink.width} ${ink.height}`);
  if (width !== undefined) svg.setAttribute('width', String(width));
  if (height !== undefined) svg.setAttribute('height', String(height));
  for (const d of ink.paths) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    // The stylesheet's rule for all SVGs would otherwise outline these instead of filling them.
    path.style.fill = '#000';
    path.style.stroke = 'none';
    svg.append(path);
  }
  return svg;
}

/** A page as displayed, turned clockwise by `extraRotation` on top of its own rotation. */
export async function pageFrame(pdf: PDFDocumentProxy, pageIndex: number, extraRotation = 0): Promise<PageFrame> {
  const page = await pdf.getPage(pageIndex + 1);
  const [x0, y0, x1, y1] = page.view;
  return { box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, rotation: (page.rotate + extraRotation) % 360 };
}

function markSvg(w: number, h: number, zoom: number): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', String(w * zoom));
  svg.setAttribute('height', String(h * zoom));
  for (const [x1, y1, x2, y2] of [[0, 0, w, h], [w, 0, 0, h]]) {
    const line = document.createElementNS(SVG, 'line');
    line.setAttribute('x1', String(x1));
    line.setAttribute('y1', String(y1));
    line.setAttribute('x2', String(x2));
    line.setAttribute('y2', String(y2));
    // The stylesheet sets a stroke width for all SVGs, which an attribute can't override.
    line.style.strokeWidth = String(Math.max(1, Math.min(w, h) * 0.12));
    svg.append(line);
  }
  return svg;
}

/** Redraws an item's content. Sizes come straight from the item, so this matches the exported PDF. */
export function fillBody(body: HTMLElement, o: Overlay, zoom: number, assets?: ItemAssets) {
  switch (o.kind) {
    case 'text': {
      const text = document.createElement('div');
      text.className = 'ov-text';
      text.style.fontSize = `${o.size * zoom}px`;
      // A trailing line break (or no text at all) still needs a line's height.
      text.textContent = o.text === '' || o.text.endsWith('\n') ? o.text + ZERO_WIDTH_SPACE : o.text;
      body.replaceChildren(text);
      break;
    }
    case 'comb': {
      const row = document.createElement('div');
      row.className = 'ov-comb';
      row.style.fontSize = `${o.size * zoom}px`;
      for (const digit of o.digits || ' ') {
        const cell = document.createElement('span');
        cell.className = 'ov-cell';
        cell.style.width = `${o.pitch * zoom}px`;
        cell.textContent = digit;
        row.append(cell);
      }
      body.replaceChildren(row);
      break;
    }
    case 'mark':
      body.replaceChildren(markSvg(o.w, o.h, zoom));
      break;
    case 'image': {
      const img = document.createElement('img');
      img.alt = 'Signature';
      img.draggable = false;
      img.style.width = `${o.w * zoom}px`;
      img.style.height = `${o.h * zoom}px`;
      const url = assets?.imageUrl(o.assetId);
      if (url) img.src = url;
      body.replaceChildren(img);
      break;
    }
    case 'vector': {
      const ink = assets?.ink(o.assetId);
      body.replaceChildren(ink ? inkSvg(ink, o.w * zoom, o.h * zoom) : '');
      break;
    }
  }
}

/** Puts an item at its place on the page, turned if the page was rotated after it was placed. */
export function placeItem(node: HTMLElement, o: Overlay, frame: PageFrame, zoom: number) {
  const at = pageToView(frame, zoom, o);
  node.style.left = `${at.x}px`;
  node.style.top = `${at.y}px`;
  node.style.transform = `rotate(${((frame.rotation - o.angle) % 360 + 360) % 360}deg)`;
}

export function renderItem(o: Overlay, frame: PageFrame, zoom: number, assets?: ItemAssets): HTMLElement {
  const node = document.createElement('div');
  node.className = `ov ov-${o.kind}-item`;
  node.dataset.id = o.id;
  const body = document.createElement('div');
  body.className = 'ov-body';
  fillBody(body, o, zoom, assets);
  node.append(body);
  placeItem(node, o, frame, zoom);
  return node;
}

/** Draws read-only items over an already loaded page image, for thumbnails and the lightbox. */
export function addStaticLayer(parent: HTMLElement, img: HTMLImageElement, overlays: Overlay[], frame: PageFrame, assets?: ItemAssets) {
  parent.querySelector(':scope > .ov-static')?.remove();
  const { width, height } = displaySize(frame, 1);
  const layer = document.createElement('div');
  layer.className = 'ov-layer ov-static';
  layer.style.width = `${width}px`;
  layer.style.height = `${height}px`;
  layer.style.left = `${img.offsetLeft}px`;
  layer.style.top = `${img.offsetTop}px`;
  // Laid out at full size and scaled down, so small text keeps its proportions.
  layer.style.transform = `scale(${img.offsetWidth / width})`;
  layer.append(...overlays.map((o) => renderItem(o, frame, 1, assets)));
  parent.append(layer);
}
