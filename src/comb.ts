/**
 * Spaced numbers hold one character per slot: a digit, or a space for a slot left
 * vacant. So a digit can be changed or removed without moving the others.
 */

const VACANT = ' ';

export function setSlot(digits: string, slot: number, digit: string): string {
  const slots = [...digits.padEnd(slot + 1, VACANT)];
  slots[slot] = digit;
  return slots.join('');
}

export function clearSlot(digits: string, slot: number): string {
  return slot < digits.length ? setSlot(digits, slot, VACANT) : digits;
}

/** Vacant slots only matter before a digit, so the box ends at its last one. */
export const finishSlots = (digits: string) => digits.trimEnd();

/** The slot under a distance along the box. */
export function slotAt(u: number, pitch: number, count: number): number {
  return Math.min(count - 1, Math.max(0, Math.floor(u / pitch)));
}

/** The pitch after dragging the box's right edge by `du`, shared between its slots. */
export function pitchFromEdge(o: { pitch: number; size: number; digits: string }, du: number): number {
  return Math.max(o.size / 2, o.pitch + du / Math.max(1, o.digits.length));
}
