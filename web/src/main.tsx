import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './design/tokens.css';
import './design/base.css';
import './design/components.css';
import { App } from './App';
import { bootstrap, connect, useStore, getTheme, setTheme } from './lib/store';
import { Aperture } from './motion/Aperture';

setTheme(getTheme());

function Root() {
  const s = useStore();
  useEffect(() => { bootstrap().catch(() => setTimeout(() => location.reload(), 2000)); connect(); }, []);
  if (!s.ready || !s.identity) {
    return <div className="boot"><Aperture state="idle" size={120} /><p className="voice">Waking AUDA…</p></div>;
  }
  return <App />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
