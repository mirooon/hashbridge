import { describe, expect, it } from 'vitest';
import { buildSelfClaimTx } from '../src/lib/claim-tx';

const PKG = '0x' + '1'.repeat(64);

describe('buildSelfClaimTx', () => {
  it('calls htlc::claim with the object, the secret and the clock', () => {
    const tx = buildSelfClaimTx(PKG, '0x' + 'ab'.repeat(32), '07'.repeat(32));
    const data = tx.getData();
    expect(data.commands).toHaveLength(1);
    const call = data.commands[0]!.MoveCall!;
    expect(call.package).toBe(PKG);
    expect(call.module).toBe('htlc');
    expect(call.function).toBe('claim');
    expect(call.typeArguments[0]).toContain('::sui::SUI');
    expect(call.arguments).toHaveLength(3);
    expect(data.inputs).toHaveLength(3);
  });
});
