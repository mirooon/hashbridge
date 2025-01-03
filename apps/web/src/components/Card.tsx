import type { ReactNode } from 'react';

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl">
      {title && <h2 className="mb-4 text-lg font-semibold text-slate-100">{title}</h2>}
      {children}
    </section>
  );
}
