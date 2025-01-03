import { useNow } from '../hooks/useNow';
import { formatDuration } from '../lib/format';

export function Countdown({ targetMs }: { targetMs: number }) {
  const now = useNow(1000);
  return <span className="font-mono tabular-nums">{formatDuration(targetMs - now)}</span>;
}
