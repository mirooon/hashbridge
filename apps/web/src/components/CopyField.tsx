import { useState } from 'react';

export function CopyField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the value stays selectable.
    }
  }
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 flex items-center gap-2 rounded-xl bg-slate-800 px-3 py-2">
        <span className={`min-w-0 flex-1 break-all text-sm text-slate-100 ${mono ? 'font-mono' : ''}`}>{value}</span>
        <button type="button" onClick={copy} className="shrink-0 rounded-lg px-2 py-1 text-xs text-amber-400 hover:bg-slate-700">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
