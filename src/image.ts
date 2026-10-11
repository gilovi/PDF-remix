import { PDFDocument } from 'pdf-lib';

/** Image bytes pdf-lib can embed directly. */
export interface PreparedImage {
  bytes: Uint8Array;
  kind: 'jpg' | 'png';
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i;

/** Raster images we can try to turn into pages (SVG is deliberately excluded). */
export function isImageFile(file: { name: string; type: string }): boolean {
  if (file.type === 'image/svg+xml') return false;
  return file.type.startsWith('image/') || IMAGE_EXT.test(file.name);
}

export function imageKind(bytes: Uint8Array): 'jpg' | 'png' | 'other' {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return 'other';
}

/** The EXIF Orientation of a JPEG (1 = upright; 1 if absent or unreadable). */
export function jpegOrientation(bytes: Uint8Array): number {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let o = 2;
    while (o + 4 <= bytes.length && bytes[o] === 0xff) {
      const marker = bytes[o + 1];
      if (marker === 0xd9 || marker === 0xda) break; // end of image / start of scan
      const len = view.getUint16(o + 2);
      const isExif =
        marker === 0xe1 && String.fromCharCode(...bytes.subarray(o + 4, o + 10)) === 'Exif\0\0';
      if (isExif) {
        const t = o + 10;
        const le = bytes[t] === 0x49; // "II" = little-endian
        const u16 = (p: number) => view.getUint16(t + p, le);
        const u32 = (p: number) => view.getUint32(t + p, le);
        const ifd = u32(4);
        const count = u16(ifd);
        for (let i = 0; i < count; i++) {
          const entry = ifd + 2 + i * 12;
          if (u16(entry) === 0x0112) return u16(entry + 8);
        }
        return 1;
      }
      o += 2 + len;
    }
  } catch {
    // truncated or malformed: treat as upright
  }
  return 1;
}

const A4: [number, number] = [595.28, 841.89];

/** Page size (points) for an image: its own aspect ratio, fitted inside A4 in the image's orientation. */
export function pageSizeForImage(width: number, height: number): [number, number] {
  const [boxW, boxH] = width > height ? [A4[1], A4[0]] : A4;
  const scale = Math.min(boxW / width, boxH / height);
  return [width * scale, height * scale];
}

/** A PDF with one full-page image per entry, in order. Runs entirely in memory. */
export async function imagesToPdf(images: PreparedImage[]): Promise<Uint8Array> {
  if (images.length === 0) throw new Error('There are no images to add.');
  const doc = await PDFDocument.create();
  doc.setProducer('PDF Remix');
  doc.setCreator('PDF Remix');
  for (const img of images) {
    const embedded = img.kind === 'jpg' ? await doc.embedJpg(img.bytes) : await doc.embedPng(img.bytes);
    const [w, h] = pageSizeForImage(embedded.width, embedded.height);
    doc.addPage([w, h]).drawImage(embedded, { x: 0, y: 0, width: w, height: h });
  }
  return doc.save();
}

// ---------- browser-only: decoding and re-encoding ----------

/**
 * Gets an image into a form pdf-lib can embed. Upright JPEGs and PNGs are used
 * as-is (no quality loss); anything else — WebP, GIF, BMP, AVIF, HEIC where the
 * browser can decode it, or a phone photo with an EXIF rotation — is decoded
 * and re-encoded on a canvas.
 */
export async function prepareImage(file: File, forceReencode = false): Promise<PreparedImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = imageKind(bytes);
  if (!forceReencode && kind === 'jpg' && jpegOrientation(bytes) === 1) return { bytes, kind };
  if (!forceReencode && kind === 'png') return { bytes, kind };
  return reencode(file, kind === 'jpg');
}

async function reencode(file: Blob, wasJpeg: boolean): Promise<PreparedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This image format can’t be opened in this browser.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  // Photos stay JPEG; images with transparency become PNG so it's kept.
  const asJpeg = wasJpeg || isOpaque(ctx, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Couldn’t convert this image.'))),
      asJpeg ? 'image/jpeg' : 'image/png',
      0.92,
    ),
  );
  canvas.width = canvas.height = 0;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), kind: asJpeg ? 'jpg' : 'png' };
}

function isOpaque(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  if (width * height > 16_000_000) return true; // too big to scan cheaply; assume a photo
  const data = ctx.getImageData(0, 0, width, height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return false;
  return true;
}

/**
 * Turns a batch of image files into one PDF, a page per image. Images the
 * browser can't decode are skipped and reported in `failed`.
 */
export async function imageFilesToPdf(files: File[]): Promise<{ bytes: Uint8Array | null; failed: string[] }> {
  const results = await Promise.allSettled(files.map((f) => prepareImage(f)));
  const ok = files.flatMap((file, i) => {
    const r = results[i];
    return r.status === 'fulfilled' ? [{ file, image: r.value }] : [];
  });
  const failed = files.filter((_, i) => results[i].status === 'rejected').map((f) => f.name);
  if (ok.length === 0) return { bytes: null, failed };
  try {
    return { bytes: await imagesToPdf(ok.map((o) => o.image)), failed };
  } catch {
    // pdf-lib can't embed a few unusual PNG/JPEG variants; re-encode them all and retry once.
    const reencoded = await Promise.all(ok.map((o) => prepareImage(o.file, true)));
    return { bytes: await imagesToPdf(reencoded), failed };
  }
}
