import { useMemo, useState, type ReactNode } from 'react';
import { EsploraClient } from '@hashbridge/core/esplora';
import type { RecoveryFile, SwapView } from '@hashbridge/core/types';
import { ImportRecovery } from './components/ImportRecovery';
import { Steps } from './components/Steps';
import { API_URL, ESPLORA_URL, HTLC_PACKAGE_ID, SUI_GRAPHQL_URL } from './config';
import { useHashRoute } from './hooks/useHashRoute';
import { useNow } from './hooks/useNow';
import { useSwapProgress } from './hooks/useSwapProgress';
import { createApi } from './lib/api';
import { STEP_LABELS, screenFor, stepIndex, swapHref } from './lib/flow';
import { refundOffered } from './lib/refund';
import { createSwapStorage, type LocalSwapState } from './lib/storage';
import { createGraphqlHtlcReader } from './lib/sui-verify';
import { DepositStep } from './screens/DepositStep';
import { DoneStep } from './screens/DoneStep';
import { RecoveryStep } from './screens/RecoveryStep';
import { RefundStep } from './screens/RefundStep';
import { SwapForm } from './screens/SwapForm';
import { TimelineStep } from './screens/TimelineStep';

const api = createApi(API_URL);
const esplora = new EsploraClient(ESPLORA_URL);
const htlcReader = createGraphqlHtlcReader(SUI_GRAPHQL_URL);
const storage = createSwapStorage();

export interface AppSlots {
  walletAddress?: string | null;
  walletSlot?: ReactNode;
  fallbackSlot?: (recovery: RecoveryFile, view: SwapView | null) => ReactNode;
}

export default function App(slots: AppSlots) {
  const route = useHashRoute();
  return (
    <div className="min-h-screen bg-slate-950 px-4 py-10 text-slate-100">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <a href="#/" className="text-xl font-bold tracking-tight">
            Hashbridge
          </a>
          <span className="text-xs text-slate-500">BTC signet → SUI testnet · atomic swap</span>
        </header>
        {route.name === 'home' ? <Home slots={slots} /> : <SwapPage key={route.id} id={route.id} slots={slots} />}
      </div>
    </div>
  );
}

function Home({ slots }: { slots: AppSlots }) {
  const open = (state: LocalSwapState) => {
    storage.save(state);
    window.location.hash = swapHref(state.recovery.swapId);
  };
  return (
    <>
      <Steps steps={STEP_LABELS} current={0} />
      <SwapForm api={api} esplora={esplora} apiUrl={API_URL} walletAddress={slots.walletAddress} walletSlot={slots.walletSlot} onCreated={open} />
      <ImportRecovery storage={storage} onImported={(state) => { window.location.hash = swapHref(state.recovery.swapId); }} />
    </>
  );
}

function SwapPage({ id, slots }: { id: string; slots: AppSlots }) {
  const [local, setLocal] = useState(() => storage.load(id));
  if (!local) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-slate-300">This swap is not stored in this browser.</p>
        <ImportRecovery
          storage={storage}
          onImported={(state) => {
            if (state.recovery.swapId === id) setLocal(state);
            else window.location.hash = swapHref(state.recovery.swapId);
          }}
        />
      </div>
    );
  }
  return <ActiveSwap local={local} onLocalChange={setLocal} slots={slots} />;
}

function ActiveSwap({ local, onLocalChange, slots }: { local: LocalSwapState; onLocalChange(state: LocalSwapState): void; slots: AppSlots }) {
  const { recovery } = local;
  const swapApi = useMemo(() => createApi(recovery.apiUrl), [recovery.apiUrl]);
  const progress = useSwapProgress({ api: swapApi, storage, htlcReader, packageId: HTLC_PACKAGE_ID, recovery, esplora });
  const [showRefund, setShowRefund] = useState(false);
  const now = useNow(5_000);
  const screen = showRefund ? 'refund' : screenFor(local, progress.view);
  const offerRefund = refundOffered(progress.view, recovery.createdAt, now);
  const refundReason =
    progress.view?.rejectReason ?? (progress.view?.status === 'SUI_REFUNDED' ? 'you did not claim the SUI before the Sui deadline' : null);

  const markDownloaded = () => {
    storage.update(recovery.swapId, { recoveryDownloaded: true });
    onLocalChange({ ...local, recoveryDownloaded: true });
  };

  return (
    <>
      <Steps steps={STEP_LABELS} current={stepIndex(screen)} />
      {screen === 'recovery' && <RecoveryStep recovery={recovery} onDone={markDownloaded} />}
      {screen === 'deposit' && <DepositStep recovery={recovery} view={progress.view} />}
      {screen === 'timeline' && (
        <TimelineStep
          recovery={recovery}
          progress={progress}
          fallbackSlot={slots.fallbackSlot?.(recovery, progress.view)}
          onRefundOptions={offerRefund ? () => setShowRefund(true) : undefined}
        />
      )}
      {screen === 'done' && progress.view && <DoneStep view={progress.view} />}
      {screen === 'refund' && (
        <RefundStep recovery={recovery} esplora={esplora} reason={refundReason} onBack={showRefund ? () => setShowRefund(false) : undefined} />
      )}
      {screen === 'deposit' && offerRefund && (
        <button type="button" onClick={() => setShowRefund(true)} className="block w-full text-center text-sm text-slate-400 hover:underline">
          Already paid but nothing happens? Refund options
        </button>
      )}
    </>
  );
}
