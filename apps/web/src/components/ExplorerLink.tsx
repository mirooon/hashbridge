import type { ReactNode } from 'react';

export function ExplorerLink({ href, children }: { href: string | null; children: ReactNode }) {
  if (!href) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-amber-400 hover:underline">
      {children}
    </a>
  );
}
