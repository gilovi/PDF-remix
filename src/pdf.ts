import { PDFDocument } from 'pdf-lib';
import type { PageRef } from './model';

/** Throws a readable error if pdf-lib can't edit this file (e.g. it's encrypted). */
export async function checkEditable(bytes: Uint8Array): Promise<void> {
  try {
    await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/encrypt/i.test(msg)) {
      throw new Error('This PDF is password-protected or encrypted, so it can’t be edited.', { cause: err });
    }
    throw new Error(`This file couldn’t be read as a PDF (${msg}).`, { cause: err });
  }
}

/** Builds a new PDF containing `pages`, in order. Runs entirely in memory. */
export async function buildPdf(
  sources: ReadonlyMap<string, Uint8Array>,
  pages: PageRef[],
): Promise<Uint8Array> {
  if (pages.length === 0) throw new Error('There are no pages to save.');

  const out = await PDFDocument.create();
  out.setProducer('PDF Remix');
  out.setCreator('PDF Remix');

  // Copy each source's pages in one batch (shared resources are copied once),
  // then add them to the output in the requested order.
  const bySource = new Map<string, number[]>();
  for (const p of pages) {
    if (!sources.has(p.sourceId)) throw new Error(`Unknown source "${p.sourceId}".`);
    const list = bySource.get(p.sourceId) ?? [];
    list.push(p.pageIndex);
    bySource.set(p.sourceId, list);
  }

  const copied = new Map<string, ReturnType<typeof out.addPage>[]>();
  for (const [sourceId, indices] of bySource) {
    const src = await PDFDocument.load(sources.get(sourceId)!, { updateMetadata: false });
    copied.set(sourceId, await out.copyPages(src, indices));
  }

  const cursor = new Map<string, number>();
  for (const p of pages) {
    const i = cursor.get(p.sourceId) ?? 0;
    cursor.set(p.sourceId, i + 1);
    out.addPage(copied.get(p.sourceId)![i]);
  }
  return out.save();
}
