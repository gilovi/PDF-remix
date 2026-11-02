import type { Ink } from './ink';

export type Signature =
  | { id: string; kind: 'ink'; ink: Ink }
  | { id: string; kind: 'image'; png: Uint8Array; width: number; height: number };

/** Width over height, for placing a signature in proportion. */
export function signatureAspect(s: Signature): number {
  const [width, height] = s.kind === 'ink' ? [s.ink.width, s.ink.height] : [s.width, s.height];
  return width > 0 && height > 0 ? width / height : 1;
}

/**
 * This session's signatures, in memory only. A signature removed from the list
 * stays available here, because items already placed on pages still need it.
 */
export class SignatureStore {
  private all = new Map<string, Signature>();
  private hidden = new Set<string>();
  private urls = new Map<string, string>();
  private counter = 0;

  private add<T extends Signature>(signature: T): T {
    this.all.set(signature.id, signature);
    return signature;
  }

  addInk(ink: Ink) {
    return this.add<Signature & { kind: 'ink' }>({ id: `sig${++this.counter}`, kind: 'ink', ink });
  }

  addImage(png: Uint8Array, width: number, height: number) {
    return this.add<Signature & { kind: 'image' }>({ id: `sig${++this.counter}`, kind: 'image', png, width, height });
  }

  get(id: string) {
    return this.all.get(id);
  }

  /** Everything this session has, including those removed from the list. */
  everything(): Signature[] {
    return [...this.all.values()];
  }

  /** Newest first. */
  list(): Signature[] {
    return [...this.all.values()].filter((s) => !this.hidden.has(s.id)).reverse();
  }

  remove(id: string) {
    this.hidden.add(id);
  }

  ink(id: string): Ink | undefined {
    const s = this.all.get(id);
    return s?.kind === 'ink' ? s.ink : undefined;
  }

  imageUrl(id: string): string | undefined {
    const s = this.all.get(id);
    if (s?.kind !== 'image') return undefined;
    let url = this.urls.get(id);
    if (!url) {
      url = URL.createObjectURL(new Blob([s.png as BlobPart], { type: 'image/png' }));
      this.urls.set(id, url);
    }
    return url;
  }

  inks(): Map<string, Ink> {
    return new Map([...this.all.values()].flatMap((s) => (s.kind === 'ink' ? [[s.id, s.ink] as const] : [])));
  }

  pngs(): Map<string, Uint8Array> {
    return new Map([...this.all.values()].flatMap((s) => (s.kind === 'image' ? [[s.id, s.png] as const] : [])));
  }
}
