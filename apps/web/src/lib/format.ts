const SATS = 100_000_000;
const MIST = 1_000_000_000n;

export function formatBtc(sats: number): string {
  const whole = Math.floor(sats / SATS);
  const frac = String(sats % SATS).padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

export function parseBtcToSats(input: string): number | null {
  const s = input.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,8})?$/.test(s)) return null;
  const [whole = '0', frac = ''] = s.split('.');
  const sats = Number(whole) * SATS + Number(frac.padEnd(8, '0'));
  return sats > 0 && Number.isSafeInteger(sats) ? sats : null;
}

export function formatSui(mist: bigint | string, maxDecimals = 4): string {
  const value = typeof mist === 'string' ? BigInt(mist) : mist;
  const whole = value / MIST;
  const frac = (value % MIST).toString().padStart(9, '0').slice(0, maxDecimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function shortHex(s: string, head = 6, tail = 4): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}
