import { describe, expect, it } from 'vitest';
import { clearSlot, finishSlots, pitchFromEdge, setSlot, slotAt } from './comb';

describe('setSlot', () => {
  it('replaces one digit, leaving the others alone', () => {
    expect(setSlot('12345', 2, '9')).toBe('12945');
  });

  it('fills a vacant slot', () => {
    expect(setSlot('1 3', 1, '2')).toBe('123');
  });

  it('adds to the end, leaving any skipped slots vacant', () => {
    expect(setSlot('12', 2, '3')).toBe('123');
    expect(setSlot('12', 4, '3')).toBe('12  3');
  });
});

describe('clearSlot', () => {
  it('vacates a slot in the middle, keeping the later digits where they are', () => {
    expect(clearSlot('12345', 2)).toBe('12 45');
  });

  it('changes nothing past the end', () => {
    expect(clearSlot('12', 5)).toBe('12');
  });
});

describe('finishSlots', () => {
  it('drops vacant slots at the end, but keeps those in the middle and at the start', () => {
    expect(finishSlots(' 1 3  ')).toBe(' 1 3');
  });

  it('is empty when no digits remain', () => {
    expect(finishSlots('   ')).toBe('');
  });
});

describe('slotAt', () => {
  it('finds the slot under a distance along the box', () => {
    expect(slotAt(0, 20, 5)).toBe(0);
    expect(slotAt(19.9, 20, 5)).toBe(0);
    expect(slotAt(20, 20, 5)).toBe(1);
  });

  it('stays within the box', () => {
    expect(slotAt(-5, 20, 5)).toBe(0);
    expect(slotAt(500, 20, 5)).toBe(4);
  });
});

describe('pitchFromEdge', () => {
  it('shares the edge’s movement between the slots', () => {
    expect(pitchFromEdge({ pitch: 20, size: 10, digits: '1234' }, 40)).toBe(30);
    expect(pitchFromEdge({ pitch: 20, size: 10, digits: '1234' }, -40)).toBe(10);
  });

  it('counts vacant slots, as they take up room too', () => {
    expect(pitchFromEdge({ pitch: 20, size: 10, digits: '1 34' }, 40)).toBe(30);
  });

  it('treats an empty box as one slot', () => {
    expect(pitchFromEdge({ pitch: 20, size: 10, digits: '' }, 5)).toBe(25);
  });

  it('never goes narrower than half the digit size', () => {
    expect(pitchFromEdge({ pitch: 20, size: 10, digits: '12' }, -1000)).toBe(5);
  });
});
