import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router';
import { api } from './api';
import Alerts from './pages/Alerts';
import Enroll from './pages/Enroll';
import Fleet from './pages/Fleet';
import Login from './pages/Login';
import Server from './pages/Server';
import Versions from './pages/Versions';

const NAV = [
  ['/', 'Parc'],
  ['/versions', 'Versions'],
  ['/alertes', 'Alertes'],
  ['/ajouter', 'Ajouter un serveur'],
] as const;

export default function App() {
  const [auth, setAuth] = useState<'unknown' | 'in' | 'out'>('unknown');
  const { pathname } = useLocation();

  // Revenir en haut de page à chaque changement d'écran.
  // Accolades obligatoires : scrollTo renvoie une Promise dans les navigateurs récents,
  // que React prendrait pour une fonction de nettoyage.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  useEffect(() => {
    api('/api/me')
      .then(() => setAuth('in'))
      .catch(() => setAuth('out'));
    const onUnauth = () => setAuth('out');
    window.addEventListener('ezgedcc:unauthorized', onUnauth);
    return () => window.removeEventListener('ezgedcc:unauthorized', onUnauth);
  }, []);

  if (auth === 'unknown') return null;
  if (auth === 'out') return <Login onLogin={() => setAuth('in')} />;

  const logout = async () => {
    await api('/api/logout', { method: 'POST' });
    setAuth('out');
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="text-base font-semibold tracking-tight">
            EzGed <span className="text-accent">ControlCenter</span>
          </span>
          <nav className="flex flex-wrap gap-1">
            {NAV.map(([to, label]) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-panel-2 text-text' : 'text-muted hover:text-text'}`
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <button onClick={logout} className="ml-auto text-sm text-muted hover:text-text">
            Déconnexion
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-[1500px] px-4 py-5">
        <Routes>
          <Route path="/" element={<Fleet />} />
          <Route path="/serveurs/:id" element={<Server />} />
          <Route path="/versions" element={<Versions />} />
          <Route path="/alertes" element={<Alerts />} />
          <Route path="/ajouter" element={<Enroll />} />
          <Route path="*" element={<p className="text-muted">Page introuvable.</p>} />
        </Routes>
      </main>
    </div>
  );
}
