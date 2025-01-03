import { describe, expect, it } from 'vitest';
import { formatBtc, formatDuration, formatSui, parseBtcToSats, shortHex } from '../src/lib/format';

describe('formatBtc', () => {
  it('drops trailing zeros', () => {
    expect(formatBtc(100_000)).toBe('0.001');
    expect(formatBtc(1)).toBe('0.00000001');
    expect(formatBtc(150_000_000)).toBe('1.5');
    expect(formatBtc(0)).toBe('0');
  });
});

describe('parseBtcToSats', () => {
  it('parses decimal BTC amounts without float errors', () => {
    expect(parseBtcToSats('0.001')).toBe(100_000);
    expect(parseBtcToSats('0,001')).toBe(100_000);
    expect(parseBtcToSats(' 0.5 ')).toBe(50_000_000);
    expect(parseBtcToSats('1')).toBe(100_000_000);
    expect(parseBtcToSats('0.29')).toBe(29_000_000);
  });

  it('rejects invalid amounts', () => {
    for (const bad of ['', 'abc', '0', '-1', '1.', '0.000000001', '1e5']) expect(parseBtcToSats(bad)).toBeNull();
  });
});

describe('formatSui', () => {
  it('formats MIST as SUI', () => {
    expect(formatSui(12_338_000_000n)).toBe('12.338');
    expect(formatSui('1000000000')).toBe('1');
    expect(formatSui(123_456_789n, 9)).toBe('0.123456789');
    expect(formatSui(1n)).toBe('0');
  });
});

describe('formatDuration', () => {
  it('renders m:ss and h:mm:ss, rounding up', () => {
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(999)).toBe('0:01');
    expect(formatDuration(-5)).toBe('0:00');
  });
});

describe('shortHex', () => {
  it('shortens long strings only', () => {
    expect(shortHex('abcdef0123456789', 4, 4)).toBe('abcd…6789');
    expect(shortHex('abcdef', 4, 4)).toBe('abcdef');
  });
});
