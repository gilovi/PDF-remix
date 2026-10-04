export type Shortcut = 'undo' | 'redo' | 'selectAll';

type KeyInfo = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;

/** Maps Ctrl/Cmd key combinations to app shortcuts, independent of keyboard layout. */
export function shortcutFor(e: KeyInfo): Shortcut | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  // Use the typed letter on Latin layouts (so AZERTY's Z works), and fall back
  // to the physical key on others (e.g. Hebrew, where Z types "ז").
  const letter = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : /^Key[A-Z]$/.test(e.code) ? e.code[3].toLowerCase() : '';
  if (letter === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (letter === 'y' && !e.shiftKey) return 'redo';
  if (letter === 'a' && !e.shiftKey) return 'selectAll';
  return null;
}
