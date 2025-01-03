export function Steps({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs">
      {steps.map((label, i) => (
        <li key={label} className="flex items-center gap-2">
          <span
            className={`flex h-6 w-6 items-center justify-center rounded-full ${
              i < current ? 'bg-emerald-500 text-slate-950' : i === current ? 'bg-amber-400 text-slate-950' : 'bg-slate-800 text-slate-500'
            }`}
          >
            {i + 1}
          </span>
          <span className={i === current ? 'text-slate-100' : 'text-slate-500'}>{label}</span>
          {i < steps.length - 1 && <span className="h-px w-4 bg-slate-700" />}
        </li>
      ))}
    </ol>
  );
}
