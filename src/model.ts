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

/**
 * Moves every selected run of pages one step earlier (`-1`) or later (`1`),
 * hopping over its unselected neighbour. Runs already at that edge stay put.
 * Returns the input array itself when nothing moves.
 */
export function shiftPages(pages: PageRef[], ids: ReadonlySet<string>, delta: -1 | 1): PageRef[] {
  const out = [...pages];
  let moved = false;
  const order = delta < 0 ? out.keys() : [...out.keys()].reverse();
  for (const i of order) {
    const j = i + delta;
    if (j < 0 || j >= out.length) continue;
    if (ids.has(out[i].id) && !ids.has(out[j].id)) {
      [out[i], out[j]] = [out[j], out[i]];
      moved = true;
    }
  }
  return moved ? out : pages;
}

export function insertPages(pages: PageRef[], inserted: PageRef[], index: number): PageRef[] {
  const at = clamp(index, 0, pages.length);
  return [...pages.slice(0, at), ...inserted, ...pages.slice(at)];
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
