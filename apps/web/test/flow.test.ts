import type { RecoveryFile, SwapView } from '@hashbridge/core/types';
import { describe, expect, it } from 'vitest';
import { parseRoute, screenFor, stepIndex, swapHref } from '../src/lib/flow';
import type { LocalSwapState } from '../src/lib/storage';

const local = (recoveryDownloaded = true): LocalSwapState => ({
  recovery: { swapId: 's' } as RecoveryFile, recoveryDownloaded, revealedAt: null, revealedHtlcId: null,
});
const view = (status: SwapView['status']) => ({ status }) as SwapView;

describe('screenFor', () => {
  it('asks for the recovery file first', () => {
    expect(screenFor(local(false), view('SUI_LOCKED'), false)).toBe('recovery');
  });

  it('maps statuses to screens', () => {
    expect(screenFor(local(), null, false)).toBe('deposit');
    expect(screenFor(local(), view('AWAITING_DEPOSIT'), false)).toBe('deposit');
    expect(screenFor(local(), view('DEPOSIT_SEEN'), false)).toBe('timeline');
    expect(screenFor(local(), view('SUI_LOCKED'), false)).toBe('timeline');
    expect(screenFor(local(), view('SUI_CLAIMED'), true)).toBe('done');
    expect(screenFor(local(), view('BTC_CLAIMED'), true)).toBe('done');
    expect(screenFor(local(), view('REJECTED'), false)).toBe('refund');
    expect(screenFor(local(), view('EXPIRED'), false)).toBe('refund');
    expect(screenFor(local(), view('SUI_REFUNDED'), false)).toBe('refund');
  });

  it('shows the swap as done only once the claim is confirmed on-chain, whatever the bot says', () => {
    expect(screenFor(local(), view('SUI_CLAIMED'), false)).toBe('timeline');
    expect(screenFor(local(), view('BTC_CLAIMED'), false)).toBe('timeline');
    expect(screenFor(local(), view('SUI_LOCKED'), true)).toBe('timeline');
  });
});

describe('routes', () => {
  it('parses swap routes and falls back to home', () => {
    expect(parseRoute('#/swap/9b2c-11ef')).toEqual({ name: 'swap', id: '9b2c-11ef' });
    expect(parseRoute('')).toEqual({ name: 'home' });
    expect(parseRoute('#/swap/')).toEqual({ name: 'home' });
    expect(parseRoute('#/swap/a/b')).toEqual({ name: 'home' });
    expect(swapHref('abc')).toBe('#/swap/abc');
  });

  it('numbers the steps', () => {
    expect(stepIndex('recovery')).toBe(1);
    expect(stepIndex('refund')).toBe(3);
    expect(stepIndex('done')).toBe(4);
  });
});
