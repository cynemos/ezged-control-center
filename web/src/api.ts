export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// Préfixe de publication, lu dans la balise <base> injectée par le serveur ('' à la racine).
export const BASE_PATH = new URL(document.baseURI).pathname.replace(/\/+$/, '');

export async function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(path.startsWith('/') ? BASE_PATH + path : path, {
    credentials: 'same-origin',
    ...rest,
    headers: json !== undefined ? { 'content-type': 'application/json', ...rest.headers } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 401 && !path.startsWith('/api/login')) {
    window.dispatchEvent(new Event('ezgedcc:unauthorized'));
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* corps non JSON */
    }
    throw new ApiError(res.status, msg);
  }
  return res.json();
}

export type Status = 'pending' | 'offline' | 'critical' | 'warning' | 'ok';

export interface ServerSummary {
  id: string;
  name: string;
  hostname: string;
  client: string | null;
  status: Status;
  lastSeen: string | null;
  cpu: number | null;
  mem: number | null;
  diskMax: number | null;
  backupAgeHours: number | null;
  httpMs: number | null;
  pendingReboot: boolean;
  versions: { ezged: string | null; apache: string | null; php: string | null; mariadb: string | null; windows: string | null };
  windowsUpdatesPending: number | null;
  alerts: { critical: number; warning: number };
  rustdeskId: string | null;
  agentVersion: string | null;
}

export interface AlertRow {
  id: number;
  server_id?: string;
  rule: string;
  severity: 'warning' | 'critical';
  message: string;
  opened_at: string;
  closed_at: string | null;
  acked: boolean;
  server_name?: string;
  client_name?: string | null;
}
