import { useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router';
import { api } from './api';
import { Logo } from './components/ui';
import About from './pages/About';
import Alerts from './pages/Alerts';
import Enroll from './pages/Enroll';
import Fleet from './pages/Fleet';
import Help from './pages/Help';
import Login from './pages/Login';
import Server from './pages/Server';
import ToDeploy, { ToDeployCount } from './pages/ToDeploy';
import Ssl from './pages/Ssl';
import Versions from './pages/Versions';

const NAV = [
  ['/', 'Parc'],
  ['/versions', 'Versions'],
  ['/alertes', 'Alertes'],
  ['/a-deployer', 'Agents à déployer'],
  ['/certificat', 'Certificat SSL'],
  ['/ajouter', 'Ajouter un serveur'],
] as const;

export default function App() {
  const [auth, setAuth] = useState<'unknown' | 'in' | 'out'>('unknown');
  const [version, setVersion] = useState<string | null>(null);
  const { pathname } = useLocation();

  // Revenir en haut de page à chaque changement d'écran.
  // Accolades obligatoires : scrollTo renvoie une Promise dans les navigateurs récents,
  // que React prendrait pour une fonction de nettoyage.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  useEffect(() => {
    api<{ version?: string }>('/api/me')
      .then((me) => {
        setVersion(me.version ?? null);
        setAuth('in');
      })
      .catch(() => setAuth('out'));
    const onUnauth = () => setAuth('out');
    window.addEventListener('ezgedcc:unauthorized', onUnauth);
    return () => window.removeEventListener('ezgedcc:unauthorized', onUnauth);
  }, []);

  if (auth === 'unknown') return null;
  if (auth === 'out')
    return (
      <Login
        onLogin={() => {
          setAuth('in');
          void api<{ version?: string }>('/api/me').then(
            (me) => setVersion(me.version ?? null),
            () => undefined,
          );
        }}
      />
    );

  const logout = async () => {
    await api('/api/logout', { method: 'POST' });
    setAuth('out');
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-line/70 bg-bg/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
          <NavLink to="/" className="flex items-center gap-2.5">
            <Logo />
            <span className="text-[15px] font-semibold tracking-tight">
              EzGed <span className="text-gradient">ControlCenter</span>
            </span>
            {version && (
              <span
                className="rounded-md border border-line bg-white/[0.03] px-1.5 py-px font-mono text-[10px] text-muted"
                title="Version de la console"
              >
                {version}
              </span>
            )}
          </NavLink>
          <nav className="flex flex-wrap gap-1">
            {NAV.map(([to, label]) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  `relative rounded-lg px-3 py-1.5 text-sm transition ${
                    isActive
                      ? 'bg-accent/12 text-text shadow-[inset_0_0_0_1px_rgb(76_154_255/0.35)]'
                      : 'text-muted hover:bg-white/[0.04] hover:text-text'
                  }`
                }
              >
                {label}
                {to === '/a-deployer' && <ToDeployCount />}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-4">
            <span className="hidden items-center gap-2 text-xs text-muted sm:inline-flex" title="Données rafraîchies automatiquement">
              <span className="relative inline-flex h-2 w-2">
                <span className="absolute inset-0 animate-ping rounded-full bg-ok opacity-60" />
                <span className="relative h-2 w-2 rounded-full bg-ok" />
              </span>
              En direct
            </span>
            <NavLink
              to="/aide"
              className={({ isActive }) => `text-sm transition hover:text-text ${isActive ? 'text-text' : 'text-muted'}`}
              title="Aide"
            >
              Aide
            </NavLink>
            <button onClick={logout} className="text-sm text-muted transition hover:text-text">
              Déconnexion
            </button>
          </div>
        </div>
        <div className="h-px animate-sweep bg-[linear-gradient(90deg,transparent,rgb(76_154_255/0.7),rgb(139_92_246/0.7),transparent)] bg-[length:50%_100%] bg-no-repeat" />
      </header>
      <main className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-6">
        <Routes>
          <Route path="/" element={<Fleet />} />
          <Route path="/serveurs/:id" element={<Server />} />
          <Route path="/versions" element={<Versions />} />
          <Route path="/alertes" element={<Alerts />} />
          <Route path="/a-deployer" element={<ToDeploy />} />
          <Route path="/certificat" element={<Ssl />} />
          <Route path="/ajouter" element={<Enroll />} />
          <Route path="/aide" element={<Help />} />
          <Route path="/a-propos" element={<About />} />
          <Route path="*" element={<p className="text-muted">Page introuvable.</p>} />
        </Routes>
      </main>
      <footer className="mt-10 border-t border-line/60">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-4 text-xs text-muted">
          <span>
            EzGed ControlCenter{version && <span className="font-mono"> {version}</span>} · <span className="text-text/80">@CYNEPROD</span>{' '}
            Cyril Nectoux
          </span>
          <span className="flex gap-4">
            <Link to="/aide" className="transition hover:text-text">
              Aide
            </Link>
            <Link to="/a-propos" className="transition hover:text-text">
              À propos
            </Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
