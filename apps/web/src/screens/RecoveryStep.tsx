import { useState } from 'react';
import type { RecoveryFile } from '@hashbridge/core/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { recoveryFileName, serializeRecoveryFile } from '../lib/storage';

export function RecoveryStep({ recovery, onDone }: { recovery: RecoveryFile; onDone(): void }) {
  const [downloaded, setDownloaded] = useState(false);

  function download() {
    const blob = new Blob([serializeRecoveryFile(recovery)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = recoveryFileName(recovery);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setDownloaded(true);
  }

  return (
    <Card title="Save your recovery file">
      <p className="text-sm text-slate-300">
        This file holds your secret and your refund key. If this browser loses its data before the swap finishes, the file is the
        only way to get your BTC back.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Button onClick={download}>Download recovery file</Button>
        <Button variant="secondary" disabled={!downloaded} onClick={onDone}>
          Continue
        </Button>
      </div>
    </Card>
  );
}
