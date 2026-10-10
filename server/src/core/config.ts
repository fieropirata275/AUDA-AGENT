import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

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

/** A Chromium-family browser for AUDA's computer and PDF rendering: Playwright's, then Chrome, Chromium or Edge. */
export function findChromium(): string | undefined {
  const home = os.homedir();
  const env = (k: string) => process.env[k] ?? '';
  const pwBases = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', path.join(home, '.cache', 'ms-playwright'),
    path.join(home, 'Library', 'Caches', 'ms-playwright'), env('LOCALAPPDATA') && path.join(env('LOCALAPPDATA'), 'ms-playwright')].filter(Boolean) as string[];
  const candidates: string[] = [];
  for (const base of pwBases) {
    try {
      for (const d of fs.readdirSync(base).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
        const cft = path.join('Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'); // Playwright ≥1.5x ships Chrome for Testing
        candidates.push(path.join(base, d, 'chrome-linux64', 'chrome'), path.join(base, d, 'chrome-linux', 'chrome'),
          path.join(base, d, 'chrome-win64', 'chrome.exe'), path.join(base, d, 'chrome-win', 'chrome.exe'),
          path.join(base, d, 'chrome-mac-arm64', cft), path.join(base, d, 'chrome-mac-x64', cft),
          path.join(base, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'), path.join(base, d, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
      }
    } catch { /* no playwright browsers here */ }
    candidates.push(path.join(base, 'chromium'));
  }
  if (process.platform === 'win32') {
    for (const root of [env('ProgramFiles'), env('ProgramFiles(x86)'), env('LOCALAPPDATA')].filter(Boolean)) {
      candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(root, 'Chromium', 'Application', 'chrome.exe'), path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    for (const app of ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Chromium.app/Contents/MacOS/Chromium', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge']) {
      candidates.push(path.join('/Applications', app), path.join(home, 'Applications', app));
    }
  } else {
    candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/snap/bin/chromium');
  }
  return candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
}

for (const d of [config.dataDir, config.workspaceDir, config.browserProfileDir, config.artifactsDir]) {
  fs.mkdirSync(d, { recursive: true });
}
