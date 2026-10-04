import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// The worker and all of pdf.js's data files are served from our own origin.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const assetBase = new URL('./pdfjs/', document.baseURI).href;

export type { PDFDocumentProxy };

export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({
    // pdf.js transfers (detaches) the buffer it's given, so hand it a copy.
    data: bytes.slice(),
    cMapUrl: `${assetBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase}standard_fonts/`,
    wasmUrl: `${assetBase}wasm/`,
    iccUrl: `${assetBase}iccs/`,
    enableXfa: false,
  }).promise;
}

/** Renders a page to an image blob URL, `cssWidth` CSS pixels wide (scaled for HiDPI). */
export async function renderPage(
  doc: PDFDocumentProxy,
  pageIndex: number,
  cssWidth: number,
): Promise<string> {
  const page = await doc.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: (cssWidth * dpr) / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, viewport }).promise;
  page.cleanup();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Render failed'))), 'image/png'),
  );
  canvas.width = canvas.height = 0;
  return URL.createObjectURL(blob);
}

/** Caches rendered thumbnails and limits how many render at once. */
export class ThumbnailCache {
  private urls = new Map<string, Promise<string>>();
  private queue: (() => void)[] = [];
  private active = 0;

  constructor(private concurrency = 3) {}

  get(key: string, render: () => Promise<string>): Promise<string> {
    let p = this.urls.get(key);
    if (!p) {
      p = this.schedule(render);
      p.catch(() => this.urls.delete(key));
      this.urls.set(key, p);
    }
    return p;
  }

  peek(key: string): Promise<string> | undefined {
    return this.urls.get(key);
  }

  /** Revokes and forgets every entry whose key starts with `prefix`. */
  drop(prefix: string) {
    for (const [key, p] of this.urls) {
      if (key.startsWith(prefix)) {
        p.then(URL.revokeObjectURL, () => {});
        this.urls.delete(key);
      }
    }
  }

  private schedule(task: () => Promise<string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const run = () => {
        this.active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.queue.shift()?.();
          });
      };
      if (this.active < this.concurrency) run();
      else this.queue.push(run);
    });
  }
}
