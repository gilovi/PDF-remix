export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Longest side kept from an uploaded signature: plenty for a placed signature, and it keeps PDFs small. */
const MAX_SIDE = 1600;
const WHITE_THRESHOLD = 230;
/** Pixels fainter than this don't count as ink when cropping. */
const MIN_ALPHA = 8;

/** Makes pixels transparent when every channel is at or above `threshold`, in place. */
export function clearWhite(data: Uint8ClampedArray, threshold: number) {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] >= threshold && data[i + 1] >= threshold && data[i + 2] >= threshold) data[i + 3] = 0;
  }
}

/** The box around everything visible, or null if there's nothing. */
export function inkBounds(data: Uint8ClampedArray, width: number, height: number): Bounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] <= MIN_ALPHA) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function fitWithin(width: number, height: number, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Turns an uploaded file into a cropped, transparent PNG. Browser only, as it needs a canvas. */
export async function prepareUpload(file: Blob, removeWhite: boolean): Promise<{ png: Uint8Array; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_SIDE);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const image = context.getImageData(0, 0, width, height);
  if (removeWhite) clearWhite(image.data, WHITE_THRESHOLD);
  const bounds = inkBounds(image.data, width, height);
  if (!bounds) throw new Error('This image looks empty.');

  canvas.width = bounds.width;
  canvas.height = bounds.height;
  context.putImageData(image, -bounds.x, -bounds.y);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The image couldn’t be read.'))), 'image/png'),
  );
  return { png: new Uint8Array(await blob.arrayBuffer()), width: bounds.width, height: bounds.height };
}
