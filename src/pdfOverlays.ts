import { LineCapStyle, degrees, rgb, type PDFDocument, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { localToPage, visibleBox, type Point } from './coords';
import type { Angle, Overlay } from './overlay';
import { BASELINE, placeLines, type Coverage, type FontName } from './textlayout';

export interface FontFiles {
  fontkit: Parameters<PDFDocument['registerFontkit']>[0];
  hebrew: Uint8Array;
  latin: Uint8Array;
}

export interface OverlayResources {
  /** Image bytes (PNG) by `assetId`. */
  assets?: ReadonlyMap<string, Uint8Array>;
  /** Supplies fontkit and the fonts, called only when an output contains text or numbers. */
  loadFonts: () => Promise<FontFiles>;
}

interface DrawContext {
  fonts: Record<FontName, PDFFont> | null;
  coverage: Coverage | null;
  images: Map<string, PDFImage>;
}

const INK = rgb(0, 0, 0);

const usesFonts = (o: Overlay) => o.kind === 'text' || o.kind === 'comb';

/** Embeds everything the items need, once per document, so duplicates share it. */
export async function prepareOverlays(doc: PDFDocument, items: Overlay[], { assets, loadFonts }: OverlayResources): Promise<DrawContext> {
  const context: DrawContext = { fonts: null, coverage: null, images: new Map() };
  if (items.some(usesFonts)) {
    const files = await loadFonts();
    doc.registerFontkit(files.fontkit);
    const he = await doc.embedFont(files.hebrew, { subset: true });
    const la = await doc.embedFont(files.latin, { subset: true });
    const heChars = new Set(he.getCharacterSet());
    const laChars = new Set(la.getCharacterSet());
    context.fonts = { he, la };
    context.coverage = {
      he: (c) => heChars.has(c.codePointAt(0)!),
      la: (c) => laChars.has(c.codePointAt(0)!),
    };
  }
  for (const o of items) {
    if (o.kind !== 'image' || context.images.has(o.assetId)) continue;
    const bytes = assets?.get(o.assetId);
    if (!bytes) throw new Error('A signature or image on this document is no longer available.');
    context.images.set(o.assetId, await doc.embedPng(bytes));
  }
  return context;
}

/** The two strokes of an X, corner to corner of its box. */
export function markStrokes(o: Point & { angle: Angle; w: number; h: number }) {
  return [
    { start: localToPage(o, 0, 0), end: localToPage(o, o.w, o.h) },
    { start: localToPage(o, o.w, 0), end: localToPage(o, 0, o.h) },
  ];
}

/** Each digit centred in its slot, always left to right. */
export function combSlots(digits: string, pitch: number, width: (digit: string) => number) {
  return [...digits].map((digit, i) => ({ digit, u: i * pitch + (pitch - width(digit)) / 2 }));
}

export function drawOverlays(page: PDFPage, overlays: Overlay[], { fonts, coverage, images }: DrawContext) {
  const box = visibleBox(page.getCropBox(), page.getMediaBox());
  const onPage = (p: Point) => ({ x: p.x + box.x, y: p.y + box.y });

  for (const o of overlays) {
    const rotate = degrees(o.angle);
    switch (o.kind) {
      case 'text':
        for (const line of placeLines(o.text, o.size, coverage!, (r) => fonts![r.font].widthOfTextAtSize(r.text, o.size))) {
          for (const run of line.runs) {
            const at = onPage(localToPage(o, run.u, line.v));
            page.drawText(run.text, { ...at, size: o.size, font: fonts![run.font], color: INK, rotate });
          }
        }
        break;
      case 'comb': {
        const font = fonts!.la;
        for (const { digit, u } of combSlots(o.digits, o.pitch, (d) => font.widthOfTextAtSize(d, o.size))) {
          const at = onPage(localToPage(o, u, o.size * BASELINE));
          page.drawText(digit, { ...at, size: o.size, font, color: INK, rotate });
        }
        break;
      }
      case 'mark': {
        const thickness = Math.max(1, Math.min(o.w, o.h) * 0.12);
        for (const { start, end } of markStrokes(o)) {
          page.drawLine({ start: onPage(start), end: onPage(end), thickness, color: INK, lineCap: LineCapStyle.Round });
        }
        break;
      }
      case 'image':
        page.drawImage(images.get(o.assetId)!, { ...onPage(localToPage(o, 0, o.h)), width: o.w, height: o.h, rotate });
        break;
    }
  }
}
