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

export interface Snapshot {
  agentVersion?: string;
  hostname?: string;
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
  /** URL publique via Apache, si configurée dans l'agent : 2xx/3xx/401/403 attendu. */
  web?: HttpCheck | null;
  backup?: { dir: string; lastFile: string | null; lastAt: string | null; sizeBytes: number | null; ageHours: number | null };
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
  ezged?: { root?: string; port?: string; repository?: string; database?: string; dbSizeMB?: number | null };
  windowsUpdates?: { pending?: number | null; lastInstalledAt?: string | null; error?: string };
  certificates?: { file: string; subject: string; notAfter: string; daysLeft: number }[];
  hardware?: { model?: string; cpuName?: string; cores?: number };
}

export interface AgentReport extends Snapshot {
  inventory?: Inventory;
}
