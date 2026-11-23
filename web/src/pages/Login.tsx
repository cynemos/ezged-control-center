import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Button, Logo } from '../components/ui';

export default function Login({ onLogin }: { onLogin: () => void }) {
  const [user, setUser] = useState('admin');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ totp: boolean }>('/api/auth-info')
      .then((r) => setNeedTotp(r.totp))
      .catch(() => {});
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/login', { method: 'POST', json: { user, password, totp } });
      onLogin();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/20 blur-[120px]" />
      <div className="pointer-events-none absolute left-[58%] top-[38%] h-72 w-72 rounded-full bg-accent-2/20 blur-[100px]" />
      <form onSubmit={submit} className="glass relative w-full max-w-sm animate-rise space-y-4 rounded-2xl p-7">
        <div className="flex flex-col items-center gap-2 pb-2 text-center">
          <Logo size={52} />
          <h1 className="text-xl font-semibold tracking-tight">
            EzGed <span className="text-gradient">ControlCenter</span>
          </h1>
          <span className="text-sm text-muted">Supervision du parc EzGED</span>
        </div>
        <label className="block space-y-1">
          <span className="text-sm text-muted">Utilisateur</span>
          <input className="w-full" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" />
        </label>
        <label className="block space-y-1">
          <span className="text-sm text-muted">Mot de passe</span>
          <input
            className="w-full"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
          />
        </label>
        {needTotp && (
          <label className="block space-y-1">
            <span className="text-sm text-muted">Code de double authentification</span>
            <input
              className="w-full tracking-widest"
              inputMode="numeric"
              maxLength={6}
              value={totp}
              onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))}
              autoComplete="one-time-code"
            />
          </label>
        )}
        {error && <p className="text-sm text-crit">{error}</p>}
        <div className="pt-1 [&>button]:w-full">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Connexion…' : 'Se connecter'}
          </Button>
        </div>
      </form>
    </div>
  );
}
