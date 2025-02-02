import { useState, type ChangeEvent } from 'react';
import { importRecoveryFile } from '../lib/refund';
import type { LocalSwapState, SwapStorage } from '../lib/storage';

export function ImportRecovery({ storage, onImported }: { storage: SwapStorage; onImported(state: LocalSwapState): void }) {
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      onImported(importRecoveryFile(await file.text(), storage));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="text-center text-sm text-slate-400">
      <label className="cursor-pointer text-amber-400 hover:underline">
        Import recovery file
        <input type="file" accept="application/json,.json" className="hidden" onChange={onFile} />
      </label>
      {error && <p className="mt-2 text-red-300">{error}</p>}
    </div>
  );
}
