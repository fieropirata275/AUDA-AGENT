/**
 * Make sure AUDA's browser has a Chromium to run. Order: AUDA_CHROMIUM, an
 * installed Chrome / Chromium / Edge (re-detected, so installing one later just
 * works), then — once, single-flight — Playwright's own Chromium, downloaded
 * with the playwright-core CLI that ships with AUDA (~170 MB, into the usual
 * ms-playwright cache). AUDA_BROWSER_AUTOINSTALL=0 turns the download off.
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { config, findChromium } from '../core/config.ts';
import { activity } from '../core/activity.ts';
import { log } from '../core/log.ts';

const isFile = (p?: string) => { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } };
let installing: Promise<string> | null = null;
export const browserInstall: { state: 'idle' | 'installing' | 'failed'; error?: string } = { state: 'idle' };

function playwrightCli(): string {
  const pkg = createRequire(import.meta.url).resolve('playwright-core/package.json');
  return path.join(path.dirname(pkg), 'cli.js');
}

/** The installer command: overridable for tests (AUDA_BROWSER_INSTALLER = a node script that installs). */
function runInstaller(): Promise<void> {
  const script = process.env.AUDA_BROWSER_INSTALLER ?? playwrightCli();
  const args = process.env.AUDA_BROWSER_INSTALLER ? [script] : [script, 'install', 'chromium'];
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { timeout: 20 * 60_000, maxBuffer: 16 << 20, windowsHide: true, env: process.env }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${(stderr || stdout || err.message).toString().trim().split('\n').slice(-3).join(' ')}`));
      else resolve();
    });
  });
}

export async function ensureBrowserBinary(): Promise<string> {
  if (isFile(config.chromiumPath)) return config.chromiumPath!;
  const found = process.env.AUDA_CHROMIUM && isFile(process.env.AUDA_CHROMIUM) ? process.env.AUDA_CHROMIUM : findChromium();
  if (found) { config.chromiumPath = found; return found; }
  if (process.env.AUDA_BROWSER_AUTOINSTALL === '0') throw new Error('No Chrome, Chromium or Edge found on AUDA’s computer. Install one, or set AUDA_CHROMIUM to its path.');
  installing ??= (async () => {
    browserInstall.state = 'installing';
    activity('recover', 'Installing a browser for AUDA', { detail: 'No Chrome, Chromium or Edge was found, so AUDA is downloading its own Chromium (about 170 MB, once).' });
    log.info('installing Playwright Chromium for AUDA’s browser');
    try {
      await runInstaller();
      const p = findChromium();
      if (!p) throw new Error('the download finished but no Chromium was found afterwards');
      config.chromiumPath = p;
      browserInstall.state = 'idle';
      activity('recover', 'AUDA’s browser is ready', { detail: p });
      return p;
    } catch (e) {
      browserInstall.state = 'failed'; browserInstall.error = (e as Error).message;
      throw new Error(`Couldn’t install a browser automatically (${(e as Error).message}). Install Chrome or Edge, or run: npx playwright-core install chromium`);
    } finally { installing = null; }
  })();
  return installing;
}
