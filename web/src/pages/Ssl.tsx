import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { Button, PageHeader, Pill } from "../components/ui";
import { ago, dateTime } from "../format";
import { usePoll } from "../hooks";

interface Bundle {
  id: string;
  uploadedAt: string;
  cn: string;
  subject: string;
  sans: string[];
  issuer: string;
  notBefore: string;
  notAfter: string;
  thumbprint: string;
  hasKey: boolean;
}

interface Target {
  id: string;
  name: string;
  client: string | null;
  agentVersion: string | null;
  agentOk: boolean;
  online: boolean;
  inventoryAt: string | null;
  certs: { file: string; notAfter: string; daysLeft: number }[];
  upToDate: boolean;
  job: {
    status: "pending" | "running" | "ok" | "failed";
    attempts: number;
    message: string | null;
    requestedAt: string;
    updatedAt: string;
  } | null;
}

interface SslStatus {
  bundle: Bundle | null;
  agentMin: string;
  fleetCerts: { cn: string; servers: number; nextExpiry: string }[];
  targets: Target[];
}

const day = (iso: string) => new Date(iso).toLocaleDateString("fr-FR");
const daysUntil = (iso: string) =>
  Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000);

function JobState({ t }: { t: Target }) {
  const j = t.job;
  if (j?.status === "pending")
    return <Pill tone="muted">en attente de l'agent</Pill>;
  if (j?.status === "running")
    return <Pill tone="warn">remplacement en cours</Pill>;
  if (j?.status === "failed") return <Pill tone="crit">échec</Pill>;
  if (t.upToDate) return <Pill tone="ok">à jour</Pill>;
  if (j?.status === "ok") return <Pill tone="ok">remplacé</Pill>;
  return <Pill tone="warn">ancien certificat</Pill>;
}

// Certificat SSL commun du parc : dépôt des fichiers reçus, essai sur un serveur, puis remplacement
// sur tous les serveurs qui présentent un certificat du même nom.
export default function Ssl() {
  const { data, reload } = usePoll<SslStatus>("/api/ssl", 10_000);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const { bundle, targets } = data;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      void reload();
    }
  }

  async function upload(list: FileList | null) {
    if (!list?.length) return;
    const files = await Promise.all(
      [...list].map(async (f) => ({ name: f.name, content: await f.text() })),
    );
    setWarnings([]);
    await run(async () => {
      const r = await api<{ warnings: string[] }>("/api/ssl", {
        method: "POST",
        json: { files },
      });
      setWarnings(r.warnings);
    });
  }

  const deploy = (ids: string[]) =>
    run(async () => {
      const r = await api<{
        queued: number;
        skipped: { name: string; reason: string }[];
      }>("/api/ssl/deploy", {
        method: "POST",
        json: { serverIds: ids },
      });
      if (r.skipped.length)
        setWarnings(r.skipped.map((s) => `${s.name} : ${s.reason}`));
    });

  const busyJob = (t: Target) =>
    t.job?.status === "pending" || t.job?.status === "running";
  const remaining = targets.filter(
    (t) => !t.upToDate && t.agentOk && !busyJob(t) && t.job?.status !== "ok",
  );
  const tested = targets.some(
    (t) => t.job?.status === "ok" || (t.upToDate && t.job),
  );
  const done = targets.filter((t) => t.upToDate).length;
  const usable = Boolean(
    bundle?.hasKey && new Date(bundle.notBefore).getTime() <= Date.now(),
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Certificat SSL"
        subtitle={
          bundle ? (
            <>
              <b>{bundle.cn}</b> :{" "}
              <b className={done === targets.length ? "text-ok" : "text-warn"}>
                {done}
              </b>{" "}
              serveur(s) à jour sur {targets.length}.
            </>
          ) : (
            "Déposer le certificat reçu pour le remplacer sur les serveurs EzGED."
          )
        }
      />

      {error && (
        <div className="rounded-xl border border-crit/50 bg-crit/10 p-4 text-sm text-crit">
          {error}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-xl border border-warn/40 bg-warn/5 p-4 text-sm text-warn">
          {warnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      )}

      <div className="glass space-y-3 rounded-xl p-5 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <label className="cursor-pointer rounded-lg border border-accent/70 bg-accent/10 px-3.5 py-1.5 font-medium text-text transition hover:bg-accent/20">
            {bundle ? "Déposer un nouveau certificat" : "Déposer les fichiers"}
            <input
              type="file"
              multiple
              accept=".crt,.key,.pem,.cer,.ca-bundle,.txt"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                void upload(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <span className="text-xs text-muted">
            Les 3 fichiers en une fois (certificat .crt, clé .key, chaîne
            .ca-bundle), au format texte PEM. La console vérifie que la clé
            correspond et que la chaîne est complète.
          </span>
        </div>

        {bundle && (
          <div className="grid gap-x-8 gap-y-1 border-t border-line pt-3 text-xs sm:grid-cols-2">
            <div>
              <span className="text-muted">Noms : </span>
              {bundle.sans.length ? bundle.sans.join(", ") : bundle.cn}
            </div>
            <div>
              <span className="text-muted">Émetteur : </span>
              {bundle.issuer}
            </div>
            <div>
              <span className="text-muted">Valide : </span>
              du {day(bundle.notBefore)} au <b>{day(bundle.notAfter)}</b> (
              {daysUntil(bundle.notAfter)} j)
            </div>
            <div>
              <span className="text-muted">Empreinte SHA-1 : </span>
              <span className="font-mono">{bundle.thumbprint}</span>
            </div>
            <div>
              <span className="text-muted">Déposé </span>
              <span title={dateTime(bundle.uploadedAt)}>
                {ago(bundle.uploadedAt)}
              </span>
            </div>
            <div className="flex items-center gap-3">
              {bundle.hasKey ? (
                <>
                  <span className="text-muted">
                    Clé privée stockée chiffrée.
                  </span>
                  <button
                    className="text-crit transition hover:underline"
                    onClick={() =>
                      confirm(
                        "Effacer la clé privée de la console ? Plus aucun remplacement ne sera possible sans redéposer les fichiers.",
                      ) &&
                      void run(() => api("/api/ssl/key", { method: "DELETE" }))
                    }
                  >
                    Effacer la clé
                  </button>
                </>
              ) : (
                <span className="text-muted">
                  Clé privée effacée de la console.
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {bundle && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              disabled={busy || !usable || !tested || !remaining.length}
              onClick={() =>
                confirm(
                  `Remplacer le certificat sur ${remaining.length} serveur(s) ? Apache y est redémarré (coupure de quelques secondes) ; en cas d'échec, l'ancien certificat est remis.`,
                ) && void deploy(remaining.map((t) => t.id))
              }
            >
              Déployer sur tous ({remaining.length})
            </Button>
            <span className="text-xs text-muted">
              {!usable
                ? bundle.hasKey
                  ? "Certificat pas encore valide."
                  : "Clé effacée : redéposer les fichiers pour un nouveau remplacement."
                : tested
                  ? "L'agent remplace le certificat à son rapport suivant (une minute environ)."
                  : "Tester d’abord sur un serveur : le déploiement sur tous est possible après un premier succès."}
            </span>
          </div>

          <div className="glass animate-rise overflow-x-auto rounded-xl">
            <table>
              <thead>
                <tr>
                  <th>Serveur</th>
                  <th>Client</th>
                  <th>Certificat actuel</th>
                  <th>Agent</th>
                  <th>État</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {targets.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link
                        to={`/serveurs/${t.id}`}
                        className="font-medium hover:text-accent"
                      >
                        {t.name}
                      </Link>
                      {!t.online && (
                        <div className="text-[11px] text-muted">hors ligne</div>
                      )}
                    </td>
                    <td className="text-muted">{t.client ?? "—"}</td>
                    <td className="text-xs">
                      {t.certs.map((c) => (
                        <div key={c.file} title={c.file}>
                          expire le {day(c.notAfter)}{" "}
                          <span
                            className={
                              c.daysLeft <= 15 ? "text-warn" : "text-muted"
                            }
                          >
                            ({c.daysLeft} j)
                          </span>
                        </div>
                      ))}
                      {t.inventoryAt && (
                        <div className="text-[11px] text-muted">
                          relevé {ago(t.inventoryAt)}
                        </div>
                      )}
                    </td>
                    <td className="text-xs">
                      <span
                        className={t.agentOk ? "text-muted" : "text-warn"}
                        title={
                          t.agentOk
                            ? ""
                            : `Version ${data.agentMin} requise : mise à jour automatique en attente`
                        }
                      >
                        {t.agentVersion ?? "—"}
                      </span>
                    </td>
                    <td className="min-w-[180px] max-w-[420px] whitespace-normal">
                      <JobState t={t} />
                      {t.job?.message && (
                        <div
                          className={`mt-1 text-[11px] ${t.job.status === "failed" ? "text-crit" : "text-muted"}`}
                        >
                          {t.job.message}
                        </div>
                      )}
                      {t.job && (
                        <div className="text-[11px] text-muted">
                          {ago(t.job.updatedAt)}
                        </div>
                      )}
                    </td>
                    <td className="text-right">
                      {busyJob(t)
                        ? t.job?.status === "pending" && (
                            <button
                              className="text-xs text-muted transition hover:text-text"
                              onClick={() =>
                                void run(() =>
                                  api("/api/ssl/cancel", {
                                    method: "POST",
                                    json: { serverIds: [t.id] },
                                  }),
                                )
                              }
                            >
                              Annuler
                            </button>
                          )
                        : !t.upToDate &&
                          t.agentOk &&
                          usable && (
                            <button
                              disabled={busy}
                              className="rounded-md border border-accent/50 px-2 py-0.5 text-xs text-accent transition hover:bg-accent/10"
                              onClick={() =>
                                confirm(
                                  `Remplacer le certificat sur ${t.name} ? Apache y est redémarré (coupure de quelques secondes).`,
                                ) && void deploy([t.id])
                              }
                            >
                              {t.job?.status === "failed"
                                ? "Réessayer"
                                : tested
                                  ? "Remplacer"
                                  : "Tester sur ce serveur"}
                            </button>
                          )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {targets.length === 0 && (
              <p className="py-12 text-center text-muted">
                Aucun serveur ne présente de certificat {bundle.cn} dans sa
                configuration Apache.
              </p>
            )}
          </div>
        </>
      )}

      {!bundle && data.fleetCerts.length > 0 && (
        <div className="glass overflow-x-auto rounded-xl">
          <table>
            <thead>
              <tr>
                <th>Certificats Apache du parc</th>
                <th>Serveurs</th>
                <th>Prochaine expiration</th>
              </tr>
            </thead>
            <tbody>
              {data.fleetCerts.map((c) => (
                <tr key={c.cn}>
                  <td className="font-medium">{c.cn}</td>
                  <td className="tabular-nums">{c.servers}</td>
                  <td
                    className={
                      daysUntil(c.nextExpiry) <= 15 ? "text-warn" : "text-muted"
                    }
                  >
                    {day(c.nextExpiry)} ({daysUntil(c.nextExpiry)} j)
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
