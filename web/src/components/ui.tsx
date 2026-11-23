import type { ReactNode } from 'react';
import type { HealthLight, LightState, Status } from '../api';

export const STATUS_LABEL: Record<Status, string> = {
  ok: 'OK',
  warning: 'Alerte',
  critical: 'Critique',
  offline: 'Hors ligne',
  pending: 'En attente',
};

/** Couleur CSS de chaque état (anneaux, halos, graphiques). */
export const STATUS_HEX: Record<Status, string> = {
  ok: 'var(--color-ok)',
  warning: 'var(--color-warn)',
  critical: 'var(--color-crit)',
  offline: 'var(--color-off)',
  pending: 'var(--color-accent)',
};

const STATUS_BG: Record<Status, string> = {
  ok: 'bg-ok',
  warning: 'bg-warn',
  critical: 'bg-crit',
  offline: 'bg-off',
  pending: 'bg-accent',
};

const STATUS_BADGE: Record<Status, string> = {
  ok: 'text-ok border-ok/35 bg-ok/10',
  warning: 'text-warn border-warn/40 bg-warn/10',
  critical: 'text-crit border-crit/50 bg-crit/12',
  offline: 'text-muted border-off/50 bg-off/15',
  pending: 'text-accent border-accent/40 bg-accent/10',
};

/** Point lumineux de l'état, avec halo pulsé pour les états critiques. */
export function Dot({ status, className = '' }: { status: Status; className?: string }) {
  const live = status === 'critical';
  return (
    <span className={`relative inline-flex h-2.5 w-2.5 shrink-0 ${className}`}>
      {live && <span className={`absolute inset-0 animate-ping rounded-full ${STATUS_BG[status]} opacity-60`} />}
      <span className={`relative inline-block h-2.5 w-2.5 rounded-full ${STATUS_BG[status]}`} style={{ boxShadow: `0 0 10px ${STATUS_HEX[status]}` }} />
    </span>
  );
}

export function StatusDot({ status }: { status: Status }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Dot status={status} />
      <span className="text-xs text-muted">{STATUS_LABEL[status]}</span>
    </span>
  );
}

/** Badge d'état : point + libellé dans une pastille colorée. */
export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_BADGE[status]}`}>
      <Dot status={status} className="scale-75" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Card({
  title,
  children,
  right,
  className = '',
  bodyClass = 'p-4',
}: {
  title?: ReactNode;
  children: ReactNode;
  right?: ReactNode;
  className?: string;
  bodyClass?: string;
}) {
  return (
    <section className={`glass min-w-0 animate-rise rounded-xl ${className}`}>
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-line/70 px-4 py-3">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold tracking-wide">
            <span className="h-3.5 w-1 rounded-full bg-gradient-to-b from-accent to-accent-2" />
            {title}
          </h2>
          {right}
        </header>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

function levelColor(v: number, warn: number, crit: number): string {
  return v >= crit ? 'var(--color-crit)' : v >= warn ? 'var(--color-warn)' : 'var(--color-ok)';
}

/** Pourcentage avec barre colorée selon les seuils. */
export function Gauge({ value, warn = 80, crit = 90 }: { value: number | null | undefined; warn?: number; crit?: number }) {
  if (value === null || value === undefined) return <span className="text-muted">—</span>;
  const c = levelColor(value, warn, crit);
  return (
    <span className="inline-flex items-center gap-2">
      <span className="relative inline-block h-1.5 w-16 overflow-hidden rounded-full bg-white/[0.06]">
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${Math.max(2, Math.min(100, value))}%`, background: c, boxShadow: `0 0 8px ${c}` }}
        />
      </span>
      <span className="w-9 text-right text-xs tabular-nums">{Math.round(value)} %</span>
    </span>
  );
}

/** Jauge circulaire : arc coloré selon les seuils, valeur au centre, libellé dessous. */
export function Ring({
  value,
  label,
  warn = 80,
  crit = 90,
  size = 56,
  stroke = 5,
}: {
  value: number | null | undefined;
  label: string;
  warn?: number;
  crit?: number;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const v = value ?? null;
  const c = v === null ? 'var(--color-off)' : levelColor(v, warn, crit);
  const dash = v === null ? 0 : (Math.min(100, Math.max(0, v)) / 100) * circ;
  return (
    <div className="flex flex-col items-center gap-1" title={`${label} : ${v === null ? 'inconnu' : `${Math.round(v)} %`}`}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(255 255 255 / 0.07)" strokeWidth={stroke} />
          {v !== null && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={c}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${Math.max(dash, 0.01)} ${circ}`}
              style={{ filter: `drop-shadow(0 0 4px ${c})`, transition: 'stroke-dasharray .6s ease' }}
            />
          )}
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-[12px] font-semibold tabular-nums" style={{ fontSize: size * 0.22 }}>
          {v === null ? '—' : Math.round(v)}
          {v !== null && <span className="ml-px text-[0.6em] font-normal text-muted">%</span>}
        </span>
      </div>
      <span className="text-[10px] uppercase tracking-wider text-muted">{label}</span>
    </div>
  );
}

/** Anneau segmenté (répartition), avec un contenu libre au centre. */
export function Donut({
  parts,
  size = 150,
  stroke = 14,
  children,
}: {
  parts: { key: string; label: string; value: number; color: string }[];
  size?: number;
  stroke?: number;
  children?: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const total = parts.reduce((a, p) => a + p.value, 0);
  const shown = parts.filter((p) => p.value > 0);
  const gap = shown.length > 1 ? 4 : 0;
  let offset = 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(255 255 255 / 0.06)" strokeWidth={stroke} />
        {total > 0 &&
          shown.map((p) => {
            const len = (p.value / total) * circ;
            const seg = (
              <circle
                key={p.key}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={p.color}
                strokeWidth={stroke}
                strokeDasharray={`${Math.max(len - gap, 0.5)} ${circ}`}
                strokeDashoffset={-offset}
                style={{ filter: `drop-shadow(0 0 6px ${p.color})` }}
              >
                <title>
                  {p.label} : {p.value}
                </title>
              </circle>
            );
            offset += len;
            return seg;
          })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  );
}

export function Kv({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-2 text-sm">
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
    ok: 'text-ok border-ok/35 bg-ok/10',
    warn: 'text-warn border-warn/40 bg-warn/10',
    crit: 'text-crit border-crit/45 bg-crit/12',
    muted: 'text-muted border-line bg-white/[0.03]',
  }[tone];
  return <span className={`inline-block rounded-md border px-1.5 py-0.5 text-xs leading-tight ${cls}`}>{children}</span>;
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
    default: 'border-line bg-white/[0.04] hover:border-accent/60 hover:bg-accent/10',
    primary:
      'border-accent/70 bg-gradient-to-b from-[#5aa6ff] to-[#3b82f6] text-white shadow-[0_6px_20px_-8px_rgb(76_154_255/0.8)] hover:brightness-110',
    danger: 'border-crit/50 text-crit hover:bg-crit/10',
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-3.5 py-1.5 text-sm font-medium transition disabled:opacity-50 ${cls}`}
    >
      {children}
    </button>
  );
}

/** Groupe de boutons exclusifs (onglets, vues, plages). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
}: {
  value: T;
  options: readonly (readonly [T, ReactNode])[];
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
}) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-black/20 p-0.5">
      {options.map(([k, label]) => (
        <button
          key={k}
          onClick={() => onChange(k)}
          className={`rounded-md transition ${size === 'sm' ? 'px-2.5 py-0.5 text-xs' : 'px-3 py-1 text-sm'} ${
            value === k ? 'bg-accent/90 text-white shadow-[0_0_14px_-2px_rgb(76_154_255/0.7)]' : 'text-muted hover:text-text'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const LIGHT_CLASS: Record<LightState, string> = {
  ok: 'border-ok/30 bg-ok/10 text-ok',
  warning: 'border-warn/45 bg-warn/12 text-warn',
  critical: 'border-crit/60 bg-crit/18 text-crit shadow-[0_0_10px_-2px_var(--color-crit)]',
  na: 'border-line bg-white/[0.02] text-muted/50',
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
          className={`rounded-md border font-medium leading-none ${LIGHT_CLASS[l.state]} ${
            size === 'md' ? 'px-2.5 py-1.5 text-xs' : 'px-1.5 py-[3px] text-[10px]'
          } ${l.state === 'critical' ? 'animate-glow' : ''}`}
        >
          {l.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Résumé compact des voyants pour les tableaux : seuls les voyants en défaut sont nommés,
 * le reste est compté (« 7 OK »).
 */
export function HealthSummary({ lights }: { lights: HealthLight[] }) {
  const bad = lights.filter((l) => l.state === 'critical' || l.state === 'warning');
  const ok = lights.filter((l) => l.state === 'ok').length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {bad
        .sort((a, b) => (a.state === b.state ? 0 : a.state === 'critical' ? -1 : 1))
        .map((l) => (
          <span key={l.key} title={`${l.label} : ${LIGHT_TITLE[l.state]}`} className={`rounded-md border px-1.5 py-[3px] text-[10px] font-medium leading-none ${LIGHT_CLASS[l.state]}`}>
            {l.label}
          </span>
        ))}
      <span className="text-[11px] text-muted" title={lights.filter((l) => l.state === 'ok').map((l) => l.label).join(', ')}>
        {bad.length === 0 ? `tout OK (${ok})` : `${ok} OK`}
      </span>
    </div>
  );
}

/** En-tête de page : titre, sous-titre, actions à droite. */
export function PageHeader({ title, subtitle, right }: { title: string; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

/** Logo : hexagone dégradé et tracé de pouls. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="lg-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5aa6ff" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <path d="M16 2 28 9v14l-12 7-12-7V9z" fill="url(#lg-logo)" opacity="0.18" stroke="url(#lg-logo)" strokeWidth="1.5" />
      <path d="M7 17h5l2-5 3.5 9 2.5-6 1.5 2H25" fill="none" stroke="#e8eef8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
