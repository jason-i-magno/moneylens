import { describe, it, expect } from 'vitest';
import { formatMonth } from './dates';

describe('formatMonth', () => {
  it('names the month and year', () => {
    expect(formatMonth('2026-10')).toBe('October 2026');
    expect(formatMonth('2025-01')).toBe('January 2025');
    expect(formatMonth('2024-12')).toBe('December 2024');
  });
});
