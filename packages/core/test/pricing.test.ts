import { describe, expect, it } from 'vitest';
import { quoteMist } from '../src/pricing';

describe('quoteMist', () => {
  it('converts sats to MIST at the rate', () => {
    expect(quoteMist(100_000, 12_400, 0)).toBe(12_400_000_000n);
  });

  it('applies the spread', () => {
    expect(quoteMist(100_000, 12_400, 50)).toBe(12_338_000_000n);
    expect(quoteMist(1_000_000, 12_400, 50)).toBe(123_380_000_000n);
  });

  it('supports fractional rates', () => {
    expect(quoteMist(100_000, 0.5, 0)).toBe(500_000n);
  });

  it('returns zero for zero sats', () => {
    expect(quoteMist(0, 12_400, 50)).toBe(0n);
  });

  it('rejects invalid inputs', () => {
    expect(() => quoteMist(1.5, 12_400, 0)).toThrow(/btcSats/);
    expect(() => quoteMist(-1, 12_400, 0)).toThrow(/btcSats/);
    expect(() => quoteMist(1, 0, 0)).toThrow(/rate/);
    expect(() => quoteMist(1, 12_400, 10_000)).toThrow(/spreadBps/);
  });
});
