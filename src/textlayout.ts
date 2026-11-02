import bidiFactory from 'bidi-js';

/** Line spacing, in font sizes. The editor's CSS line-height must match. */
export const LINE_HEIGHT = 1.2;
/**
 * First baseline below the box top, in font sizes: half-leading plus ascent, from
 * Heebo's metrics (ascent 2146, descent 862, 2048 per em), as a browser lays it out.
 */
export const BASELINE = (LINE_HEIGHT - (2146 + 862) / 2048) / 2 + 2146 / 2048;

export type FontName = 'he' | 'la';

/** Which characters each font file can draw. */
export interface Coverage {
  he(char: string): boolean;
  la(char: string): boolean;
}

export interface Run {
  text: string;
  font: FontName;
  level: number;
}

export interface PlacedRun extends Run {
  /** Distance from the left of the text box. */
  u: number;
}

export interface PlacedLine {
  runs: PlacedRun[];
  /** Baseline distance below the top of the text box. */
  v: number;
}

const bidi = bidiFactory();
const isHebrew = (c: string) => /[\u0590-\u05FF\uFB1D-\uFB4F]/.test(c);
const isMark = (c: string) => /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/.test(c);
/** Invisible direction and joining controls: they steer the layout but have no glyph to draw. */
const isControl = (c: string) => /[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/.test(c);

function pickFont(c: string, previous: FontName | null, has: Coverage): FontName {
  if (isHebrew(c)) return 'he';
  if (has.la(c)) return has.he(c) && previous === 'he' ? 'he' : 'la';
  return has.he(c) ? 'he' : 'la';
}

/**
 * Splits one line into runs drawn left to right. fontkit reverses RTL script by
 * itself, so Hebrew runs must stay in typed order: reordering them first (or
 * reordering the whole string) prints them backwards and crashes on niqqud.
 * Only the order of the runs follows the Unicode bidi algorithm (rule L2).
 */
export function layoutRuns(text: string, has: Coverage): Run[] {
  const { levels } = bidi.getEmbeddingLevels(text);
  const logical: Run[] = [];
  let offset = 0;
  let previous: FontName | null = null;
  for (const c of text) {
    const level = levels[offset]; // bidi-js levels are per UTF-16 unit
    offset += c.length;
    if (isControl(c)) continue;
    const font = pickFont(c, previous, has);
    const last = logical[logical.length - 1];
    if (last && last.level === level && (last.font === font || isMark(c))) last.text += c;
    else logical.push({ text: c, level, font });
    previous = font;
  }

  const runs = logical.slice();
  const highest = Math.max(0, ...runs.map((r) => r.level));
  const lowestOdd = Math.min(Infinity, ...runs.filter((r) => r.level % 2).map((r) => r.level));
  for (let level = highest; level >= lowestOdd; level--) {
    for (let i = 0; i < runs.length; i++) {
      if (runs[i].level < level) continue;
      let j = i;
      while (j + 1 < runs.length && runs[j + 1].level >= level) j++;
      runs.splice(i, j - i + 1, ...runs.slice(i, j + 1).reverse());
      i = j;
    }
  }

  return runs.map((run) => {
    if (run.level % 2 === 0) return run;
    const mirrored = [...run.text].map((c) => bidi.getMirroredCharacter(c) ?? c);
    // fontkit only reverses text it recognises as RTL script, so neutral-only runs are ours to reverse.
    return { ...run, text: (mirrored.some(isHebrew) ? mirrored : mirrored.reverse()).join('') };
  });
}

/** Direction of a line, from its first strong character. Neutral-only lines read left to right. */
export function isRtlLine(line: string): boolean {
  return line !== '' && bidi.getEmbeddingLevels(line).paragraphs[0].level % 2 === 1;
}

/** Characters neither font can draw, once each, so the editor can warn about them. */
export function missingChars(text: string, has: Coverage): string[] {
  const missing = new Set<string>();
  for (const c of text) {
    if (!isControl(c) && !/\s/.test(c) && !has.he(c) && !has.la(c)) missing.add(c);
  }
  return [...missing];
}

/**
 * Lays out multi-line text. Lines break only where the text does; each gets its
 * own bidi pass, and RTL lines align to the right of the widest line.
 */
export function placeLines(text: string, size: number, has: Coverage, measure: (run: Run) => number): PlacedLine[] {
  const lines = text.split(/\r\n|\r|\n/).map((raw) => {
    const line = raw.replace(/\t/g, ' ');
    let width = 0;
    const runs = layoutRuns(line, has).map((run) => {
      const placed = { ...run, u: width };
      width += measure(run);
      return placed;
    });
    return { runs, width, rtl: isRtlLine(line) };
  });
  const boxWidth = Math.max(...lines.map((l) => l.width));
  return lines.map((line, i) => ({
    v: size * (BASELINE + i * LINE_HEIGHT),
    runs: line.rtl ? line.runs.map((r) => ({ ...r, u: r.u + boxWidth - line.width })) : line.runs,
  }));
}
