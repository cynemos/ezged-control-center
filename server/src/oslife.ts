// Fin de support Microsoft des versions de Windows rencontrées sur le parc.
// Dates de fin du support étendu (serveurs) ou de la maintenance (postes, éditions Pro/Famille).
// À compléter quand une nouvelle version de Windows arrive sur le parc.

interface Entry {
  build: number;
  name: string;
  end: string;
}

const SERVER: Entry[] = [
  { build: 7601, name: 'Windows Server 2008 R2', end: '2020-01-14' },
  { build: 9200, name: 'Windows Server 2012', end: '2023-10-10' },
  { build: 9600, name: 'Windows Server 2012 R2', end: '2023-10-10' },
  { build: 14393, name: 'Windows Server 2016', end: '2027-01-12' },
  { build: 17763, name: 'Windows Server 2019', end: '2029-01-09' },
  { build: 20348, name: 'Windows Server 2022', end: '2031-10-14' },
  { build: 26100, name: 'Windows Server 2025', end: '2034-10-10' },
];

const CLIENT: Entry[] = [
  { build: 7601, name: 'Windows 7', end: '2020-01-14' },
  { build: 9600, name: 'Windows 8.1', end: '2023-01-10' },
  { build: 19044, name: 'Windows 10 21H2', end: '2023-06-13' },
  { build: 19045, name: 'Windows 10 22H2', end: '2025-10-14' },
  { build: 22000, name: 'Windows 11 21H2', end: '2023-10-10' },
  { build: 22621, name: 'Windows 11 22H2', end: '2024-10-08' },
  { build: 22631, name: 'Windows 11 23H2', end: '2025-11-11' },
  { build: 26100, name: 'Windows 11 24H2', end: '2026-10-13' },
  { build: 26200, name: 'Windows 11 25H2', end: '2027-10-12' },
];

export interface OsSupport {
  /** Date de fin de support (AAAA-MM-JJ), null si la version n'est pas dans la table. */
  endOfSupport: string | null;
  /** Jours restants avant la fin de support (négatif : dépassée). */
  supportDaysLeft: number | null;
}

/** Fin de support d'après le libellé Windows (« Microsoft Windows Server 2022 Standard ») et le build (« 20348.2849 »). */
export function osSupport(caption: string | undefined, build: string | undefined, now = Date.now()): OsSupport {
  const major = Number.parseInt(build ?? '', 10);
  if (!caption || !Number.isFinite(major)) return { endOfSupport: null, supportDaysLeft: null };
  const table = /server/i.test(caption) ? SERVER : CLIENT;
  const e = table.find((x) => x.build === major);
  if (!e) return { endOfSupport: null, supportDaysLeft: null };
  return { endOfSupport: e.end, supportDaysLeft: Math.floor((new Date(`${e.end}T23:59:59Z`).getTime() - now) / 86_400_000) };
}
