// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob } from './download';

describe('downloadBlob', () => {
  afterEach(() => vi.restoreAllMocks());

  it('saves via a temporary link that can never navigate the app tab away', () => {
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadBlob(new Blob(['x'], { type: 'application/pdf' }), 'out.pdf');

    expect(click).toHaveBeenCalledOnce();
    const clicked = click.mock.contexts[0] as HTMLAnchorElement | undefined;

    expect(clicked).toBeDefined();
    expect(clicked!.download).toBe('out.pdf');
    expect(clicked!.href).toBe('blob:fake');
    // If a browser ignores `download` (e.g. iOS Safari), the PDF opens in a new tab
    // instead of replacing the app — so the work and undo history survive.
    expect(clicked!.target).toBe('_blank');
    expect(clicked!.rel).toContain('noopener');
    expect(document.querySelector('a')).toBeNull();
  });
});
