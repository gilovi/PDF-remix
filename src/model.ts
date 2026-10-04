/** One page of the output document: page `pageIndex` (0-based) of source `sourceId`. */
export interface PageRef {
  /** Unique per placement, so the same source page can appear twice. */
  id: string;
  sourceId: string;
  pageIndex: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

export function removePages(pages: PageRef[], ids: ReadonlySet<string>): PageRef[] {
  return pages.filter((p) => !ids.has(p.id));
}

/**
 * Moves the pages in `ids` (keeping their current relative order) to `gap`,
 * a position between pages counted in the *original* list (0 = before the
 * first page, length = after the last).
 */
export function movePages(pages: PageRef[], ids: ReadonlySet<string>, gap: number): PageRef[] {
  const at = clamp(gap, 0, pages.length);
  const moved = pages.filter((p) => ids.has(p.id));
  const before = pages.slice(0, at).filter((p) => !ids.has(p.id));
  const after = pages.slice(at).filter((p) => !ids.has(p.id));
  return [...before, ...moved, ...after];
}

export function insertPages(pages: PageRef[], inserted: PageRef[], index: number): PageRef[] {
  const at = clamp(index, 0, pages.length);
  return [...pages.slice(0, at), ...inserted, ...pages.slice(at)];
}

/** Ids of the inclusive range between `anchorId` and `targetId`. */
export function rangeSelect(pages: PageRef[], anchorId: string, targetId: string): Set<string> {
  const a = pages.findIndex((p) => p.id === anchorId);
  const b = pages.findIndex((p) => p.id === targetId);
  if (b < 0) return new Set();
  if (a < 0) return new Set([targetId]);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return new Set(pages.slice(lo, hi + 1).map((p) => p.id));
}

/** Linear undo/redo over immutable snapshots. */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];

  constructor(public current: T) {}

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }

  push(state: T) {
    this.past.push(this.current);
    this.current = state;
    this.future = [];
  }

  undo(): T {
    const prev = this.past.pop();
    if (prev !== undefined) {
      this.future.push(this.current);
      this.current = prev;
    }
    return this.current;
  }

  redo(): T {
    const next = this.future.pop();
    if (next !== undefined) {
      this.past.push(this.current);
      this.current = next;
    }
    return this.current;
  }

  reset(state: T) {
    this.past = [];
    this.future = [];
    this.current = state;
  }
}
