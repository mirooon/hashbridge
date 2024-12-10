/**
 * MIST paid for `btcSats` at `rate` SUI per BTC, minus `spreadBps`.
 * sats/1e8 BTC × rate SUI/BTC × 1e9 MIST/SUI = sats × rate × 10. The rate is scaled by 1000 to stay in integers.
 */
export function quoteMist(btcSats: number, rate: number, spreadBps: number): bigint {
  if (!Number.isInteger(btcSats) || btcSats < 0) throw new Error('btcSats must be a non-negative integer');
  if (!(rate > 0) || !Number.isFinite(rate)) throw new Error('rate must be a positive number');
  if (!Number.isInteger(spreadBps) || spreadBps < 0 || spreadBps >= 10_000) throw new Error('spreadBps must be an integer in [0, 10000)');
  const rateMilli = BigInt(Math.round(rate * 1000));
  return (BigInt(btcSats) * rateMilli * 10n * BigInt(10_000 - spreadBps)) / 10_000_000n;
}
