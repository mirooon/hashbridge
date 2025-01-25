import { buildWitnessScript, htlcAddress } from '@hashbridge/core/htlc-script';
import { randomBtcKey } from '@hashbridge/core/keys';
import { bytesToHex, generateSecret, hashSecret, hexToBytes } from '@hashbridge/core/secret';
import type { CreateSwapRequest, CreateSwapResponse, RecoveryFile } from '@hashbridge/core/types';

export const MAX_LOCKTIME_AHEAD_BLOCKS = 300;

export interface PreparedSwap {
  secret: string;
  hash: string;
  refundPrivkey: string;
  refundPubkey: string;
}

export function parseSuiAddress(input: string): string | null {
  const s = input.trim().toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(s) ? s : null;
}

export function prepareSwap(): PreparedSwap {
  const secret = generateSecret();
  const key = randomBtcKey();
  return {
    secret: bytesToHex(secret),
    hash: bytesToHex(hashSecret(secret)),
    refundPrivkey: bytesToHex(key.privateKey),
    refundPubkey: bytesToHex(key.publicKey),
  };
}

/** Recomputes the HTLC locally; any mismatch means the user must not pay. */
export function verifyBotResponse(prep: PreparedSwap, res: CreateSwapResponse, tipHeight: number): string[] {
  if (!/^0[23][0-9a-f]{64}$/.test(res.botPubkey)) return ['bot public key is malformed'];
  const problems: string[] = [];
  if (res.locktime <= tipHeight) problems.push('refund locktime is already in the past');
  if (res.locktime > tipHeight + MAX_LOCKTIME_AHEAD_BLOCKS) problems.push(`refund locktime is more than ${MAX_LOCKTIME_AHEAD_BLOCKS} blocks away`);
  let expected: Uint8Array;
  try {
    expected = buildWitnessScript({
      hash: hexToBytes(prep.hash),
      claimPubkey: hexToBytes(res.botPubkey),
      refundPubkey: hexToBytes(prep.refundPubkey),
      locktime: res.locktime,
    });
  } catch (err) {
    problems.push(`cannot rebuild the HTLC script: ${(err as Error).message}`);
    return problems;
  }
  if (bytesToHex(expected) !== res.witnessScript) problems.push('HTLC script from the bot does not match the one computed locally');
  if (htlcAddress(expected) !== res.htlcAddress) problems.push('deposit address from the bot does not match the one computed locally');
  return problems;
}

export function buildRecovery(prep: PreparedSwap, req: CreateSwapRequest, res: CreateSwapResponse, apiUrl: string, now: number): RecoveryFile {
  return {
    version: 1,
    swapId: res.swapId,
    secret: prep.secret,
    hash: prep.hash,
    refundPrivkey: prep.refundPrivkey,
    refundPubkey: prep.refundPubkey,
    botPubkey: res.botPubkey,
    locktime: res.locktime,
    witnessScript: res.witnessScript,
    htlcAddress: res.htlcAddress,
    suiRecipient: req.suiRecipient,
    btcSats: req.btcSats,
    suiAmount: res.suiAmount,
    quoteExpiresAt: res.quoteExpiresAt,
    apiUrl,
    createdAt: now,
  };
}
