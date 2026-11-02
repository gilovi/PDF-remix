import { describe, expect, it } from 'vitest';
import bidiFactory from 'bidi-js';
import fontkit from '@pdf-lib/fontkit';
import hebrewUrl from '@fontsource/heebo/files/heebo-hebrew-400-normal.woff?inline';
import latinUrl from '@fontsource/heebo/files/heebo-latin-400-normal.woff?inline';
import { BASELINE, LINE_HEIGHT, fontCoverage, isRtlLine, layoutRuns, missingChars, placeLines, type Coverage } from './textlayout';

const coverage: Coverage = {
  he: (c) => /[\u0590-\u05FF\u20AA ]/.test(c),
  la: (c) => /[\x20-\x7E]/.test(c),
};
const texts = (s: string) => layoutRuns(s, coverage).map((r) => r.text);

/** The test strings from the spike, all of which rendered correctly with this algorithm. */
const SPIKE_STRINGS = [
  'שלום עולם',
  'מנצפך ךםןףץ',
  'Hello world',
  'שלום Hello עולם',
  'Hello שלום world',
  'מספר 12345 בלבד',
  'ת.ז. 123-456-789',
  'תאריך: 12/03/2026',
  'שם (פרטי) ומשפחה',
  'סכום: ₪1,250.50',
  'טלפון 050-1234567',
  'שָׁלוֹם',
  'Name (שם) here',
  'האם זה נכון?!',
  'שלום, Hello (world) 123.',
  'בְּרֵאשִׁית and more',
  'מייל: gil@example.com',
  'הנחה של 15% בלבד',
];

describe('layoutRuns', () => {
  it('orders mixed runs visually and keeps Hebrew runs as typed (fontkit reverses those itself)', () => {
    expect(texts('שלום Hello עולם')).toEqual(['עולם', ' ', 'Hello', 'שלום ']);
    expect(texts('Hello שלום world')).toEqual(['Hello ', 'שלום', ' ', 'world']);
  });

  it('reverses neutral-only runs in RTL context itself', () => {
    expect(texts('ת.ז. 123-456-789')).toEqual(['123-456-789', ' .', 'ז', '.', 'ת']);
  });

  it('mirrors brackets in RTL context, but not in LTR context', () => {
    expect(texts('שם (פרטי) ומשפחה')).toEqual(['ומשפחה', ' (', 'פרטי', ')', 'שם ']);
    expect(texts('Name (x) here')).toEqual(['Name (x) here']);
  });

  it('keeps niqqud in its letter’s run', () => {
    expect(texts('שָׁלוֹם')).toEqual(['שָׁלוֹם']);
  });

  it('picks the font by coverage, including ₪ from the Hebrew font', () => {
    const runs = layoutRuns('Hello שלום', coverage);
    expect(runs.map((r) => r.font)).toEqual(['la', 'he']);
    expect(layoutRuns('1₪', coverage).find((r) => r.text.includes('₪'))?.font).toBe('he');
  });

  it('drops invisible direction controls, which would draw as empty boxes', () => {
    expect(texts('שלום\u200F!')).toEqual(['!', 'שלום']);
    expect(texts('a\u200Eb\u202Ac\u202C\uFEFF').join('')).toBe('abc');
  });

  it('returns nothing for empty text', () => {
    expect(layoutRuns('', coverage)).toEqual([]);
  });

  it.each(SPIKE_STRINGS)('matches the Unicode visual order for: %s', (s) => {
    // What the page shows once fontkit has reversed the Hebrew runs, compared with
    // an independent reordering. Marks are ignored: they attach to letters either way.
    const noMarks = (t: string) => t.replace(/[\u0591-\u05C7]/g, '');
    const bidi = bidiFactory();
    const expected = bidi.getReorderedString(noMarks(s), bidi.getEmbeddingLevels(noMarks(s)));
    const shown = layoutRuns(noMarks(s), coverage)
      .map((r) => (/[\u0590-\u05FF]/.test(r.text) ? [...r.text].reverse().join('') : r.text))
      .join('');
    expect(shown).toBe(expected);
  });
});

describe('isRtlLine', () => {
  it('follows the first strong character', () => {
    expect(isRtlLine('שלום abc')).toBe(true);
    expect(isRtlLine('abc שלום')).toBe(false);
    expect(isRtlLine('123 שלום')).toBe(true);
    expect(isRtlLine('123-456')).toBe(false);
    expect(isRtlLine('')).toBe(false);
  });
});

describe('missingChars', () => {
  it('lists characters neither font can draw, once each, ignoring controls and line breaks', () => {
    expect(missingChars('שלום abc\n\u200F😀😀ж', coverage)).toEqual(['😀', 'ж']);
    expect(missingChars('שלום abc ₪', coverage)).toEqual([]);
  });
});

describe('placeLines', () => {
  const measure = (run: { text: string }) => [...run.text].length * 10;

  it('puts each baseline one line height below the last', () => {
    const lines = placeLines('ab\ncd', 20, coverage, measure);
    expect(lines.map((l) => l.v)).toEqual([20 * BASELINE, 20 * (BASELINE + LINE_HEIGHT)]);
  });

  it('places runs one after another, advancing by their width', () => {
    const [line] = placeLines('Hello שלום', 20, coverage, measure);
    expect(line.runs.map((r) => [r.text, r.u])).toEqual([
      ['Hello ', 0],
      ['שלום', 60],
    ]);
  });

  it('aligns RTL lines to the right of the box and LTR lines to the left', () => {
    const lines = placeLines('שם\nabcd', 20, coverage, measure);
    expect(lines[0].runs[0].u).toBe(20);
    expect(lines[1].runs[0].u).toBe(0);
  });

  it('keeps blank lines, and accepts any line ending', () => {
    const lines = placeLines('a\r\n\rb', 10, coverage, measure);
    expect(lines.map((l) => l.runs.length)).toEqual([1, 0, 1]);
    expect(lines[2].v).toBe(10 * (BASELINE + 2 * LINE_HEIGHT));
  });

  it('turns tabs into spaces', () => {
    expect(placeLines('a\tb', 10, coverage, measure)[0].runs[0].text).toBe('a b');
  });
});

describe('fontCoverage', () => {
  it('matches what the Heebo files can really draw', async () => {
    const check = async (url: string, has: (c: string) => boolean) => {
      const font = fontkit.create(new Uint8Array(await (await fetch(url)).arrayBuffer()));
      for (let cp = 0x20; cp < 0xffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        expect([cp, has(String.fromCodePoint(cp))]).toEqual([cp, font.hasGlyphForCodePoint(cp)]);
      }
    };
    await check(hebrewUrl, fontCoverage.he);
    await check(latinUrl, fontCoverage.la);
  }, 30000);
});
