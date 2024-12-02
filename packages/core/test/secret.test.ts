import { describe, expect, it } from 'vitest';
import { bytesToHex, generateSecret, hashSecret, hexToBytes, secretMatchesHash } from '../src/secret';

describe('secret', () => {
  it('generates 32 random bytes', () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).toHaveLength(32);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('hashes with SHA-256', () => {
    expect(bytesToHex(hashSecret(new Uint8Array(32)))).toBe(
      '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925',
    );
  });

  it('refuses secrets that are not 32 bytes', () => {
    expect(() => hashSecret(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => hashSecret(new Uint8Array(600))).toThrow(/32 bytes/);
  });

  it('checks a secret against a hash', () => {
    const secret = '07'.repeat(32);
    const hash = '4bb06f8e4e3a7715d201d573d0aa423762e55dabd61a2c02278fa56cc6d294e0';
    expect(secretMatchesHash(secret, hash)).toBe(true);
    expect(secretMatchesHash('08'.repeat(32), hash)).toBe(false);
    expect(secretMatchesHash('07'.repeat(31), hash)).toBe(false);
    const lettered = 'ab'.repeat(32);
    const letteredHash = '9a2db2e23f1504cd056606553ac049c5e718e8f9ce9233876df1a7a1821af885';
    expect(secretMatchesHash(lettered, letteredHash)).toBe(true);
    expect(secretMatchesHash(lettered.toUpperCase(), letteredHash)).toBe(false);
  });

  it('round-trips hex', () => {
    expect(bytesToHex(hexToBytes('00ff10'))).toBe('00ff10');
  });
});
