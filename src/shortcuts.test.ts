import { describe, expect, it } from 'vitest';
import { shortcutFor } from './shortcuts';

const key = (k: string, code: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  key: k,
  code,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

describe('shortcutFor', () => {
  it('Ctrl+Z undoes and Ctrl+Shift+Z / Ctrl+Y redo', () => {
    expect(shortcutFor(key('z', 'KeyZ', { ctrl: true }))).toBe('undo');
    expect(shortcutFor(key('Z', 'KeyZ', { ctrl: true, shift: true }))).toBe('redo');
    expect(shortcutFor(key('y', 'KeyY', { ctrl: true }))).toBe('redo');
  });
  it('works with Cmd on a Mac', () => {
    expect(shortcutFor(key('z', 'KeyZ', { meta: true }))).toBe('undo');
    expect(shortcutFor(key('z', 'KeyZ', { meta: true, shift: true }))).toBe('redo');
  });
  it('works with a non-Latin keyboard layout (e.g. Hebrew), using the physical key', () => {
    expect(shortcutFor(key('ז', 'KeyZ', { ctrl: true }))).toBe('undo');
    expect(shortcutFor(key('ז', 'KeyZ', { ctrl: true, shift: true }))).toBe('redo');
    expect(shortcutFor(key('ט', 'KeyY', { ctrl: true }))).toBe('redo');
    expect(shortcutFor(key('ש', 'KeyA', { ctrl: true }))).toBe('selectAll');
  });
  it('respects Latin layouts where letters sit elsewhere (AZERTY: Z is on the W key)', () => {
    expect(shortcutFor(key('z', 'KeyW', { ctrl: true }))).toBe('undo');
    expect(shortcutFor(key('w', 'KeyZ', { ctrl: true }))).toBe(null);
  });
  it('Ctrl+A selects all', () => {
    expect(shortcutFor(key('a', 'KeyA', { ctrl: true }))).toBe('selectAll');
  });
  it('ignores keys without Ctrl/Cmd, or with Alt (AltGr typing)', () => {
    expect(shortcutFor(key('z', 'KeyZ'))).toBe(null);
    expect(shortcutFor(key('z', 'KeyZ', { ctrl: true, alt: true }))).toBe(null);
  });
});
