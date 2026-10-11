import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { imageKind, imagesToPdf, isImageFile, jpegOrientation, pageSizeForImage } from './image';

// ---------- fixtures (web-standard APIs only, so no Node types are needed) ----------

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const u32be = (v: number) => new Uint8Array([v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);

function crc32(data: Uint8Array): number {
  let c = ~0;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A valid RGB PNG of the given size (solid grey). */
async function makePng(width: number, height: number): Promise<Uint8Array> {
  const chunk = (type: string, data: Uint8Array) => {
    const body = concat(ascii(type), data);
    return concat(u32be(data.length), body, u32be(crc32(body)));
  };
  const ihdr = concat(u32be(width), u32be(height), new Uint8Array([8, 2, 0, 0, 0])); // 8-bit RGB
  const raw = new Uint8Array((width * 3 + 1) * height).fill(0x80);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0; // filter byte: none
  return concat(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', await zlibDeflate(raw)),
    chunk('IEND', new Uint8Array()),
  );
}

/** A minimal baseline JPEG header (SOI + SOF0 with the given size + EOI), enough for pdf-lib to embed. */
function makeJpeg(width: number, height: number, exif?: Uint8Array): Uint8Array {
  const sof = [0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00];
  const app1 = exif ? [0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255, ...exif] : [];
  return new Uint8Array([0xff, 0xd8, ...app1, ...sof, 0xff, 0xd9]);
}

/** An EXIF APP1 payload with just an Orientation tag. */
function exifOrientation(value: number, littleEndian = false): Uint8Array {
  const b = new Uint8Array(6 + 8 + 2 + 12 + 4);
  b.set(ascii('Exif\0\0'), 0);
  const t = 6;
  const view = new DataView(b.buffer);
  const u16 = (v: number, o: number) => view.setUint16(o, v, littleEndian);
  const u32 = (v: number, o: number) => view.setUint32(o, v, littleEndian);
  b.set(ascii(littleEndian ? 'II' : 'MM'), t);
  u16(42, t + 2);
  u32(8, t + 4); // IFD0 offset
  u16(1, t + 8); // one entry
  u16(0x0112, t + 10); // Orientation
  u16(3, t + 12); // SHORT
  u32(1, t + 14); // count
  u16(value, t + 18); // value (left-justified in the 4-byte field)
  u32(0, t + 22); // next IFD
  return b;
}

// ---------- tests ----------

describe('isImageFile / imageKind', () => {
  it('accepts common image types by MIME type or extension, but not SVG or PDF', () => {
    expect(isImageFile({ name: 'a.jpg', type: 'image/jpeg' })).toBe(true);
    expect(isImageFile({ name: 'scan.PNG', type: '' })).toBe(true);
    expect(isImageFile({ name: 'photo.heic', type: '' })).toBe(true);
    expect(isImageFile({ name: 'x.webp', type: 'image/webp' })).toBe(true);
    expect(isImageFile({ name: 'logo.svg', type: 'image/svg+xml' })).toBe(false);
    expect(isImageFile({ name: 'doc.pdf', type: 'application/pdf' })).toBe(false);
  });
  it('detects JPEG and PNG from their bytes, regardless of the file name', async () => {
    expect(imageKind(makeJpeg(2, 2))).toBe('jpg');
    expect(imageKind(await makePng(2, 2))).toBe('png');
    expect(imageKind(new TextEncoder().encode('GIF89a...'))).toBe('other');
  });
});

describe('jpegOrientation', () => {
  it('is 1 when there is no EXIF data', () => {
    expect(jpegOrientation(makeJpeg(4, 3))).toBe(1);
  });
  it('reads the Orientation tag (big- and little-endian EXIF)', () => {
    expect(jpegOrientation(makeJpeg(4, 3, exifOrientation(6)))).toBe(6);
    expect(jpegOrientation(makeJpeg(4, 3, exifOrientation(8, true)))).toBe(8);
  });
  it('does not throw on garbage', () => {
    expect(jpegOrientation(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(1);
    expect(jpegOrientation(new Uint8Array([1, 2, 3]))).toBe(1);
  });
});

describe('pageSizeForImage', () => {
  const A4 = [595.28, 841.89];
  it('fits a portrait image inside A4, keeping its aspect ratio', () => {
    const [w, h] = pageSizeForImage(3000, 4000);
    expect(w).toBeCloseTo(A4[0], 1);
    expect(h).toBeCloseTo((A4[0] * 4000) / 3000, 1);
  });
  it('fits a landscape image inside landscape A4', () => {
    const [w, h] = pageSizeForImage(4000, 3000);
    expect(h).toBeCloseTo(A4[0], 1);
    expect(w).toBeCloseTo((A4[0] * 4000) / 3000, 1);
  });
  it('scales small images up to page size too', () => {
    const [w, h] = pageSizeForImage(100, 100);
    expect(w).toBeCloseTo(A4[0], 1);
    expect(h).toBeCloseTo(A4[0], 1);
  });
});

describe('imagesToPdf', () => {
  it('makes one page per image, in order, sized to each image', async () => {
    const bytes = await imagesToPdf([
      { bytes: await makePng(300, 400), kind: 'png' },
      { bytes: makeJpeg(400, 300), kind: 'jpg' },
    ]);
    const doc = await PDFDocument.load(bytes);
    const sizes = doc.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
    expect(sizes).toEqual([
      [595, 794],
      [794, 595],
    ]);
  });
  it('rejects an empty list', async () => {
    await expect(imagesToPdf([])).rejects.toThrow(/no images/i);
  });
});
