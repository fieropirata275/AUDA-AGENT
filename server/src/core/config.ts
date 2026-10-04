import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '../../..');
const dataDir = path.resolve(process.env.AUDA_DATA ?? path.join(root, 'data'));

export const config = {
  root,
  dataDir,
  dbPath: path.join(dataDir, 'auda.db'),
  workspaceDir: path.resolve(process.env.AUDA_WORKSPACE ?? path.join(dataDir, 'computer', 'home')),
  browserProfileDir: path.join(dataDir, 'computer', 'browser-profile'),
  artifactsDir: path.join(dataDir, 'artifacts'),
  port: Number(process.env.AUDA_PORT ?? 4610),
  host: process.env.AUDA_HOST ?? '0.0.0.0',
  publicUrl: process.env.AUDA_PUBLIC_URL ?? `http://localhost:${process.env.AUDA_PORT ?? 4610}`,
  webDist: path.join(root, 'web', 'dist'),
  production: process.env.NODE_ENV === 'production',
  computerDriver: (process.env.AUDA_COMPUTER_DRIVER ?? 'local') as 'local' | 'docker' | 'ssh',
  chromiumPath: process.env.AUDA_CHROMIUM ?? findChromium(),
  workerConcurrency: Number(process.env.AUDA_WORKERS ?? 3),
};

function findChromium(): string | undefined {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const candidates = [
    path.join(base, 'chromium'),
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ];
  try {
    for (const d of fs.readdirSync(base)) {
      if (/^chromium-\d+$/.test(d)) candidates.unshift(path.join(base, d, 'chrome-linux', 'chrome'));
    }
  } catch { /* no playwright browsers */ }
  return candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
}

for (const d of [config.dataDir, config.workspaceDir, config.browserProfileDir, config.artifactsDir]) {
  fs.mkdirSync(d, { recursive: true });
}
