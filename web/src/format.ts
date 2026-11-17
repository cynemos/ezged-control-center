export function ago(iso: string | null | undefined): string {
  if (!iso) return 'jamais';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `il y a ${Math.max(s, 0)} s`;
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

export function pct(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : `${Math.round(n)} %`;
}

export function hours(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 48) return `${Math.round(n)} h`;
  return `${Math.round(n / 24)} j`;
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
