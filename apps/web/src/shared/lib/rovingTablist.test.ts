import { describe, expect, it } from 'vitest';
import { nextRovingIndex } from './rovingTablist';

describe('nextRovingIndex', () => {
  const count = 4;

  it('moves to the next tab on ArrowRight and wraps at the end', () => {
    expect(nextRovingIndex('ArrowRight', 0, count)).toBe(1);
    expect(nextRovingIndex('ArrowRight', 3, count)).toBe(0);
  });

  it('moves to the previous tab on ArrowLeft and wraps at the start', () => {
    expect(nextRovingIndex('ArrowLeft', 2, count)).toBe(1);
    expect(nextRovingIndex('ArrowLeft', 0, count)).toBe(3);
  });

  it('treats ArrowDown/ArrowUp like horizontal movement for a single-row tablist', () => {
    expect(nextRovingIndex('ArrowDown', 0, count)).toBe(1);
    expect(nextRovingIndex('ArrowUp', 0, count)).toBe(3);
  });

  it('jumps to the first tab on Home and the last on End', () => {
    expect(nextRovingIndex('Home', 2, count)).toBe(0);
    expect(nextRovingIndex('End', 1, count)).toBe(3);
  });

  it('returns null for keys that should not move focus', () => {
    expect(nextRovingIndex('Enter', 0, count)).toBeNull();
    expect(nextRovingIndex(' ', 0, count)).toBeNull();
    expect(nextRovingIndex('Tab', 0, count)).toBeNull();
  });

  it('is a no-op when there are no tabs', () => {
    expect(nextRovingIndex('ArrowRight', 0, 0)).toBeNull();
  });

  it('clamps an out-of-range current index before moving', () => {
    expect(nextRovingIndex('ArrowRight', 9, count)).toBe(0);
    expect(nextRovingIndex('ArrowLeft', -3, count)).toBe(3);
  });
});
