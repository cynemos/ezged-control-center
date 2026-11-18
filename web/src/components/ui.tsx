import type { ReactNode } from 'react';
import type { HealthLight, LightState, Status } from '../api';

export const STATUS_LABEL: Record<Status, string> = {
  ok: 'OK',
  warning: 'Alerte',
  critical: 'Critique',
  offline: 'Hors ligne',
  pending: 'En attente',
};

const STATUS_COLOR: Record<Status, string> = {
  ok: 'bg-ok',
  warning: 'bg-warn',
  critical: 'bg-crit',
  offline: 'bg-off',
  pending: 'bg-accent',
};

export function StatusDot({ status }: { status: Status }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${STATUS_COLOR[status]} ${status === 'critical' ? 'animate-pulse' : ''}`} />
      <span className="text-muted text-xs">{STATUS_LABEL[status]}</span>
    </span>
  );
}

export function Card({ title, children, right, className = '' }: { title?: string; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-lg border border-line bg-panel ${className}`}>
      {title && (
        <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {right}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Pourcentage avec barre colorée selon les seuils. */
export function Gauge({ value, warn = 80, crit = 90 }: { value: number | null | undefined; warn?: number; crit?: number }) {
  if (value === null || value === undefined) return <span className="text-muted">—</span>;
  const color = value >= crit ? 'bg-crit' : value >= warn ? 'bg-warn' : 'bg-ok';
  return (
    <span className="inline-flex items-center gap-2">
      <span className="relative inline-block h-1.5 w-14 overflow-hidden rounded bg-panel-2">
        <span className={`absolute inset-y-0 left-0 ${color}`} style={{ width: `${Math.min(100, value)}%` }} />
      </span>
      <span className="tabular-nums text-xs">{Math.round(value)} %</span>
    </span>
  );
}

export function Kv({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v ?? <span className="text-muted">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'crit' | 'muted'; children: ReactNode }) {
  const cls = {
    ok: 'text-ok border-ok/40 bg-ok/10',
    warn: 'text-warn border-warn/40 bg-warn/10',
    crit: 'text-crit border-crit/40 bg-crit/10',
    muted: 'text-muted border-line bg-panel-2',
  }[tone];
  return <span className={`inline-block rounded border px-1.5 py-0.5 text-xs ${cls}`}>{children}</span>;
}

export function Button({
  children,
  onClick,
  variant = 'default',
  type = 'button',
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger';
  type?: 'button' | 'submit';
  disabled?: boolean;
}) {
  const cls = {
    default: 'border-line bg-panel-2 hover:border-muted',
    primary: 'border-accent bg-accent/90 text-white hover:bg-accent',
    danger: 'border-crit/50 text-crit hover:bg-crit/10',
  }[variant];
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`rounded-md border px-3 py-1.5 text-sm disabled:opacity-50 ${cls}`}>
      {children}
    </button>
  );
}

const LIGHT_CLASS: Record<LightState, string> = {
  ok: 'border-ok/40 bg-ok/15 text-ok',
  warning: 'border-warn/50 bg-warn/15 text-warn',
  critical: 'border-crit/60 bg-crit/20 text-crit',
  na: 'border-line bg-panel-2 text-muted/60',
};
const LIGHT_TITLE: Record<LightState, string> = { ok: 'OK', warning: 'alerte', critical: 'critique', na: 'non surveillé' };

/** Voyants de santé par catégorie (agent, système, services, web, files, dump, Veeam, SSL). */
export function HealthLights({ lights, size = 'sm' }: { lights: HealthLight[]; size?: 'sm' | 'md' }) {
  return (
    <div className={`flex flex-wrap ${size === 'md' ? 'gap-1.5' : 'gap-1'}`}>
      {lights.map((l) => (
        <span
          key={l.key}
          title={`${l.label} : ${LIGHT_TITLE[l.state]}`}
          className={`rounded border font-medium leading-none ${LIGHT_CLASS[l.state]} ${
            size === 'md' ? 'px-2 py-1 text-xs' : 'px-1.5 py-[3px] text-[10px]'
          } ${l.state === 'critical' ? 'animate-pulse' : ''}`}
        >
          {l.label}
        </span>
      ))}
    </div>
  );
}

/** Mini barre verticale + valeur, pour les tuiles. */
export function MiniBar({ label, value, warn = 80, crit = 90 }: { label: string; value: number | null | undefined; warn?: number; crit?: number }) {
  const v = value ?? null;
  const color = v === null ? 'bg-panel-2' : v >= crit ? 'bg-crit' : v >= warn ? 'bg-warn' : 'bg-ok';
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex items-baseline justify-between text-[10px] text-muted">
        <span>{label}</span>
        <span className="tabular-nums text-text">{v === null ? '—' : `${Math.round(v)}%`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-panel-2">
        <div className={`h-full ${color}`} style={{ width: `${Math.min(100, v ?? 0)}%` }} />
      </div>
    </div>
  );
}
