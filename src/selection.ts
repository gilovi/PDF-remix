/** Selection rules shared by the document grid and the Files panel. */

export interface SelState<K> {
  /** Selected keys, in the order they were added. */
  selected: K[];
  /** Where a Shift-click range starts. */
  anchor: K | null;
}

export interface ClickMods {
  /** Ctrl/Cmd-click, or any click while "Select" mode is on. */
  toggle: boolean;
  /** Shift-click. */
  range: boolean;
}

export function clickSelect<K>(state: SelState<K>, all: K[], key: K, mods: ClickMods): SelState<K> {
  const { selected, anchor } = state;
  const from = anchor === null ? -1 : all.indexOf(anchor);
  const to = all.indexOf(key);
  if (mods.range && from >= 0 && to >= 0) {
    const step = from < to ? 1 : -1;
    const next = [...selected];
    for (let i = from; i !== to + step; i += step) if (!next.includes(all[i])) next.push(all[i]);
    return { selected: next, anchor };
  }
  if (mods.toggle) {
    return selected.includes(key)
      ? { selected: selected.filter((k) => k !== key), anchor: key }
      : { selected: [...selected, key], anchor: key };
  }
  // Plain click: just this page — or nothing, if it was the only one selected.
  if (selected.length === 1 && selected[0] === key) return { selected: [], anchor: null };
  return { selected: [key], anchor: key };
}

/** Selection after dragging a box over `hits`. */
export function boxSelect<K>(base: K[], hits: K[], additive: boolean): K[] {
  return additive ? [...base, ...hits.filter((k) => !base.includes(k))] : [...hits];
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function normalizeBox(x1: number, y1: number, x2: number, y2: number): Box {
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), right: Math.max(x1, x2), bottom: Math.max(y1, y2) };
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;
}
