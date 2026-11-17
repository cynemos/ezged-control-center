import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Button } from '../components/ui';

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
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-line bg-panel p-6">
        <h1 className="text-lg font-semibold">
          Ez<span className="text-accent">Mon</span>
          <span className="ml-2 text-sm font-normal text-muted">supervision du parc EzGED</span>
        </h1>
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
        <Button type="submit" variant="primary" disabled={busy}>
          Se connecter
        </Button>
      </form>
    </div>
  );
}
