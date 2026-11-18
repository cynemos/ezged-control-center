// Format du rapport envoyé par l'agent PowerShell (voir agent/ezged-cc-agent.ps1).
// Tous les champs sont optionnels : un agent plus ancien ou un serveur atypique peut en omettre.

export interface DiskInfo {
  name: string;
  sizeGB: number;
  freeGB: number;
  usedPct: number;
}

export interface ServiceInfo {
  name: string;
  status: string; // Running, Stopped, NotFound...
  startType?: string;
}

export interface QueueInfo {
  count: number;
  oldestMin: number | null;
}

export interface HttpCheck {
  url: string;
  status: number | null;
  ms: number | null;
  ok: boolean;
  error?: string | null;
}

export interface ProcessInfo {
  service: string;
  name: string;
  count: number;
  memMB: number;
  cpuPct: number | null;
  handles: number;
  threads: number;
  startedAt: string | null;
}

export interface VeeamInfo {
  service: string;
  version?: string | null;
  job?: string | null;
  lastResult?: string | null; // Success, Warning, Failed
  lastAt?: string | null;
  details?: string | null;
  lastOkAt?: string | null;
  okAgeHours?: number | null;
  running?: boolean;
  runningSince?: string | null;
}

export interface Snapshot {
  agentVersion?: string;
  hostname?: string;
  machineId?: string;
  collectedAt?: string;
  metrics?: {
    cpu?: number;
    memUsedPct?: number;
    memTotalMB?: number;
    uptimeHours?: number;
    disks?: DiskInfo[];
  };
  services?: ServiceInfo[];
  /** Serveur EzGED interne (port de instance.conf) : toute réponse HTTP < 500 = vivant. */
  http?: HttpCheck;
  /** Apache testé en local sur chaque port Listen de sa configuration (80/8000, 443/4430...). */
  apache?: HttpCheck[];
  /** URL publique via Apache, si configurée dans l'agent : 2xx/3xx/401/403 attendu. */
  web?: HttpCheck | null;
  backup?: { dir: string; lastFile: string | null; lastAt: string | null; sizeBytes: number | null; ageHours: number | null };
  /** Processus des services surveillés (somme par exécutable). cpuPct null au premier rapport. */
  processes?: ProcessInfo[];
  /** Santé de l'agent lui-même. */
  agent?: { durationMs?: number; errors?: { name: string; error: string }[]; ps?: string; dotnet?: number | null; autoUpdate?: boolean };
  /** Veeam Agent for Windows, absent (null) si non installé. */
  veeam?: VeeamInfo | null;
  queues?: Record<string, QueueInfo>;
  db?: {
    ok: boolean;
    error?: string;
    threadsConnected?: number;
    maxUsedConnections?: number;
    slowQueries?: number;
    uptimeHours?: number;
    sizeMB?: number;
  };
  pendingReboot?: boolean;
}

export interface Inventory {
  os?: { caption?: string; version?: string; build?: string; installDate?: string };
  versions?: { ezged?: string; apache?: string; php?: string; mariadb?: string };
  ezged?: {
    root?: string;
    port?: string;
    repository?: string;
    database?: string;
    dbSizeMB?: number | null;
    // Stockage des documents ([dirs] stockagesdir) ; partial = parcours interrompu après 90 s.
    docs?: { dir?: string; found?: boolean; sizeGB?: number; files?: number; partial?: boolean; at?: string } | null;
  };
  windowsUpdates?: { pending?: number | null; lastInstalledAt?: string | null; error?: string };
  certificates?: { file: string; subject: string; notAfter: string; daysLeft: number }[];
  hardware?: { model?: string; cpuName?: string; cores?: number };
}

export interface AgentReport extends Snapshot {
  inventory?: Inventory;
}
