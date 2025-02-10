import type { SwapView } from '@hashbridge/core/types';
import type { LocalSwapState } from './storage';

export type Screen = 'recovery' | 'deposit' | 'timeline' | 'done' | 'refund';

export function screenFor(local: LocalSwapState, view: SwapView | null): Screen {
  if (!local.recoveryDownloaded) return 'recovery';
  if (!view) return 'deposit';
  switch (view.status) {
    case 'AWAITING_DEPOSIT':
      return 'deposit';
    case 'DEPOSIT_SEEN':
    case 'SUI_LOCKED':
      return 'timeline';
    case 'SUI_CLAIMED':
    case 'BTC_CLAIMED':
      return 'done';
    case 'REJECTED':
    case 'EXPIRED':
    case 'SUI_REFUNDED':
      return 'refund';
  }
}

export type Route = { name: 'home' } | { name: 'swap'; id: string };

export function parseRoute(hash: string): Route {
  const match = /^#\/swap\/([A-Za-z0-9-]+)$/.exec(hash);
  return match ? { name: 'swap', id: match[1]! } : { name: 'home' };
}

export function swapHref(id: string): string {
  return `#/swap/${id}`;
}

export const STEP_LABELS = ['Amount', 'Recovery', 'Deposit', 'Swap', 'Done'] as const;

export function stepIndex(screen: Screen): number {
  return { recovery: 1, deposit: 2, timeline: 3, refund: 3, done: 4 }[screen];
}
