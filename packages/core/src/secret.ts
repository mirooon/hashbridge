import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';

export const SECRET_LENGTH = 32;

const HEX64 = /^[0-9a-f]{64}$/;

export function generateSecret(): Uint8Array {
  return randomBytes(SECRET_LENGTH);
}

export function hashSecret(secret: Uint8Array): Uint8Array {
  if (secret.length !== SECRET_LENGTH) {
    throw new Error(`secret must be ${SECRET_LENGTH} bytes, got ${secret.length}`);
  }
  return sha256(secret);
}

export function secretMatchesHash(secretHex: string, hashHex: string): boolean {
  if (!HEX64.test(secretHex) || !HEX64.test(hashHex)) return false;
  return bytesToHex(sha256(hexToBytes(secretHex))) === hashHex;
}

export { bytesToHex, hexToBytes };
