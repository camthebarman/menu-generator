import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { CostSummary, MatchGroup } from '../domain/match';
import { GROUP_LABEL } from '../domain/match';
import type { Dimension, LotStatus, Pool, Provenance, Workspace } from '../domain/types';
import { formatBase, formatMoney } from '../domain/units';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'food' | 'bar';
export function Button({ variant = 'secondary', size = 'md', className, busy, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; busy?: boolean }) {
  const v: Record<Variant, string> = {
    primary: 'bg-ink text-white hover:bg-ink-soft border-ink',
    secondary: 'bg-white text-ink border-paper-line hover:border-ink-mute',
    ghost: 'bg-transparent border-transparent text-ink hover:bg-paper-shade',
    danger: 'bg-block text-white border-block hover:opacity-90',
    food: 'bg-food text-white border-food hover:bg-food-ink',
    bar: 'bg-bar text-white border-bar hover:bg-bar-ink',
  };
  return (
    <button
      type="button"
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg border font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'min-h-[2.25rem] px-3 text-sm' : 'min-h-[2.75rem] px-4 text-sm',
        v[variant],
        className,
      )}
      disabled={busy || rest.disabled}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
      {label && <span className="text-sm">{label}</span>}
      {!label && <span className="sr-only">Working…</span>}
    </span>
  );
}

const GROUP_STYLE: Record<MatchGroup, string> = {
  make_now: 'bg-ok-soft text-ok border-ok/30',
  need_1: 'bg-warn-soft text-warn border-warn/30',
  need_2: 'bg-risk-soft text-risk border-risk/30',
  needs_review: 'bg-review-soft text-review border-review/30',
  not_close: 'bg-paper-shade text-ink-mute border-paper-line',
};

export function GroupBadge({ group }: { group: MatchGroup }) {
  return <span className={cx('chip', GROUP_STYLE[group])}>{GROUP_LABEL[group]}</span>;
}

export function ProvenanceBadge({ p }: { p: Provenance }) {
  const map = {
    house: ['House', 'bg-ink text-white border-ink'],
    starter: ['Starter', 'bg-paper-shade text-ink-soft border-paper-line'],
    imported: ['Imported', 'bg-white text-ink border-ink-mute'],
    ai_draft: ['AI draft', 'bg-review-soft text-review border-review/40'],
  } as const;
  const [label, cls] = map[p.kind];
  return (
    <span className={cx('chip', cls)} title={p.source ? `Source: ${p.source}` : undefined}>
      {label}
      {p.kind === 'imported' && p.source ? <span className="max-w-[8rem] truncate font-normal">· {p.source}</span> : null}
    </span>
  );
}

export function CostBadge({ cost, currency }: { cost: CostSummary; currency: string }) {
  if (cost.status === 'complete')
    return <span className="chip border-ok/30 bg-ok-soft text-ok">{cost.portionCost !== null ? `${formatMoney(cost.portionCost, currency)}/portion` : formatMoney(cost.knownCost, currency)}</span>;
  if (cost.status === 'partial') return <span className="chip border-warn/30 bg-warn-soft text-warn" title={`Unknown: ${cost.unknownLines.join(', ')}`}>Partial cost · {formatMoney(cost.knownCost, currency)} known</span>;
  return <span className="chip border-paper-line bg-paper-shade text-ink-mute">Cost unknown</span>;
}

export function PoolBadge({ pool }: { pool: Pool }) {
  const cls = pool === 'food' ? 'bg-food-soft text-food-ink border-food/30' : pool === 'bar' ? 'bg-bar-soft text-bar-ink border-bar/30' : 'bg-white text-ink-soft border-ink-mute/40';
  return <span className={cx('chip', cls)}>{pool === 'shared' ? 'Shared' : pool === 'food' ? 'Food' : 'Bar'}</span>;
}

export function StatusBadge({ status }: { status: LotStatus }) {
  const cls = status === 'available' ? 'bg-ok-soft text-ok border-ok/30' : status === 'needs_review' ? 'bg-review-soft text-review border-review/30' : 'bg-block-soft text-block border-block/30';
  return <span className={cx('chip', cls)}>{status.replace('_', ' ')}</span>;
}

export function Qty({ v, dim }: { v: number; dim: Dimension }) {
  return <span className="tabular-nums">{formatBase(v, dim)}</span>;
}

export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('card', className)} {...rest}>{children}</div>;
}

export function Section({ title, actions, children, description }: { title: string; actions?: ReactNode; children: ReactNode; description?: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-xl font-semibold">{title}</h2>
          {description && <p className="text-sm text-ink-mute">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function Notice({ tone = 'info', title, children, className }: { tone?: 'info' | 'warn' | 'review' | 'block' | 'ok'; title?: string; children?: ReactNode; className?: string }) {
  const cls = {
    info: 'border-ink-mute/30 bg-white',
    warn: 'border-warn/40 bg-warn-soft text-warn',
    review: 'border-review/40 bg-review-soft text-review',
    block: 'border-block/40 bg-block-soft text-block',
    ok: 'border-ok/40 bg-ok-soft text-ok',
  }[tone];
  return (
    <div role={tone === 'block' ? 'alert' : 'note'} className={cx('rounded-lg border px-3 py-2 text-sm', cls, className)}>
      {title && <div className="font-semibold">{title}</div>}
      {children && <div className={title ? 'mt-0.5' : ''}>{children}</div>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-paper-line bg-white/60 px-4 py-8 text-center">
      <div className="font-serif text-lg">{title}</div>
      {children && <div className="mt-1 text-sm text-ink-mute">{children}</div>}
    </div>
  );
}

export function Field({ label, children, hint, className }: { label: string; children: (id: string) => ReactNode; hint?: ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="label">{label}</label>
      {children(id)}
      {hint && <div className="mt-1 text-xs text-ink-mute">{hint}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <button id={id} type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 inline-flex h-6 w-11 shrink-0 rounded-full border transition', checked ? 'border-ink bg-ink' : 'border-paper-line bg-paper-shade')}>
        <span className={cx('absolute top-0.5 h-4.5 w-[1.125rem] rounded-full bg-white shadow transition', checked ? 'left-[1.4rem]' : 'left-0.5')} style={{ height: '1.125rem' }} />
      </button>
      <label htmlFor={id} className="cursor-pointer text-sm">
        <span className="font-medium">{label}</span>
        {description && <span className="block text-xs text-ink-mute">{description}</span>}
      </label>
    </div>
  );
}

export function Drawer({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <div className="no-print absolute inset-0 bg-ink/40" onClick={onClose} aria-hidden />
      <div ref={ref} tabIndex={-1} className={cx('relative flex h-full w-full flex-col bg-paper shadow-2xl outline-none', wide ? 'max-w-4xl' : 'max-w-xl')}>
        <div className="flex items-center justify-between border-b border-paper-line bg-white px-4 py-3">
          <h2 className="truncate text-lg font-semibold">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close" className="no-print">✕</Button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
      </div>
    </div>
  );
}

export function WorkspaceDot({ ws }: { ws: Workspace }) {
  return <span className={cx('inline-block h-2.5 w-2.5 rounded-full', ws === 'food' ? 'bg-food' : 'bg-bar')} aria-hidden />;
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'ok' | 'warn' | 'review' }) {
  return (
    <div className={cx('rounded-lg border px-3 py-2', tone === 'ok' ? 'border-ok/30 bg-ok-soft' : tone === 'warn' ? 'border-warn/30 bg-warn-soft' : tone === 'review' ? 'border-review/30 bg-review-soft' : 'border-paper-line bg-white')}>
      <div className="text-xs uppercase tracking-wide text-ink-mute">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
