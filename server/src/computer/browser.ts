/**
 * AUDA's browser: a persistent Chromium profile living on AUDA's computer.
 * Sessions (cookies, logins) survive restarts. The supervisor health-checks it
 * and restarts it from the last known URL if it becomes unresponsive.
 */
import { chromium, type BrowserContext, type Page, type CDPSession } from 'playwright-core';
import { config } from '../core/config.ts';
import { insert, now, q, uid, update } from '../core/db.ts';
import { publish, onViewers, viewerCount } from '../core/streams.ts';
import { log } from '../core/log.ts';

let ctx: BrowserContext | null = null;
let page: Page | null = null;
let cdp: CDPSession | null = null;
let starting: Promise<Page> | null = null;
let sessionId: string | null = null;
let screencasting = false;
let lastUrl = 'about:blank';
let lastFrame: { data: string; w: number; h: number; ts: number } | null = null;
export let activity: { action: string; url: string; ts: number } | null = null;

export const VIEWPORT = { width: 1280, height: 800 };
const IDLE_PAGE = `<!doctype html><meta charset=utf-8><title>AUDA’s browser</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 40%,#f4f0ea,#e3ddd4);font:18px Georgia,serif;color:#8a8379"><div style="text-align:center"><div style="width:84px;height:84px;margin:0 auto 18px;border-radius:50%;background:radial-gradient(circle at 36% 30%,#f3b48a,#c9602d 60%,#6e2f17);box-shadow:inset 0 0 0 22px rgba(0,0,0,0),0 12px 30px rgba(110,47,23,.25);position:relative"><div style="position:absolute;inset:30px;border-radius:50%;background:#2a211b"></div></div><i>AUDA’s browser is ready.</i><div style="font:13px system-ui;margin-top:6px;color:#a39b90">Pages AUDA opens appear here.</div></div>`;
export const available = () => Boolean(config.chromiumPath);
export const status = () => ({
  available: available(),
  running: Boolean(page && !page.isClosed()),
  url: page && !page.isClosed() ? page.url() : lastUrl,
  sessionId,
  activity,
});

export async function ensure(): Promise<Page> {
  if (page && !page.isClosed()) return page;
  if (starting) return starting;
  starting = (async () => {
    if (!config.chromiumPath) throw new Error('No Chromium found on AUDA’s computer (set AUDA_CHROMIUM).');
    ctx = await chromium.launchPersistentContext(config.browserProfileDir, {
      executablePath: config.chromiumPath,
      headless: true,
      viewport: VIEWPORT,
      args: ['--no-first-run', '--disable-dev-shm-usage', '--no-default-browser-check'],
    });
    page = ctx.pages()[0] ?? (await ctx.newPage());
    page.on('framenavigated', (f) => { if (f === page?.mainFrame()) { lastUrl = f.url(); publish('screen.meta', status()); } });
    ctx.on('close', () => { page = null; ctx = null; cdp = null; screencasting = false; });
    sessionId = uid('cs');
    const comp = q.get('SELECT id FROM computers LIMIT 1');
    insert('computer_sessions', { id: sessionId, computer_id: comp?.id ?? 'computer', kind: 'browser', state: 'running', started_at: now() });
    if (lastUrl && lastUrl !== 'about:blank') await page.goto(lastUrl, { timeout: 15_000 }).catch(() => {});
    else await page.setContent(IDLE_PAGE).catch(() => {});
    if (viewerCount('screen') > 0) await startScreencast();
    log.info('browser session started');
    return page;
  })();
  try { return await starting; } finally { starting = null; }
}

async function startScreencast() {
  if (!page || screencasting) return;
  cdp = await page.context().newCDPSession(page);
  cdp.on('Page.screencastFrame', (f: any) => {
    lastFrame = { data: f.data, w: f.metadata.deviceWidth, h: f.metadata.deviceHeight, ts: Date.now() };
    publish('screen', lastFrame);
    cdp?.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 62, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 });
  screencasting = true;
}
async function stopScreencast() {
  if (!cdp || !screencasting) return;
  screencasting = false;
  await cdp.send('Page.stopScreencast').catch(() => {});
}

onViewers('screen', (n) => {
  if (n > 0) {
    ensure().then(startScreencast).then(async () => {
      if (lastFrame) publish('screen', lastFrame);
      else if (page) { const b = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null); if (b) publish('screen', { data: b.toString('base64'), w: VIEWPORT.width, h: VIEWPORT.height, ts: Date.now() }); }
    }).catch((e) => log.warn('screencast unavailable', String(e)));
  } else stopScreencast();
});

function mark(action: string, url: string) { activity = { action, url, ts: Date.now() }; publish('screen.meta', status()); }

export async function open(url: string) {
  const p = await ensure();
  mark('Opening', url);
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await p.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  return p;
}

export async function readPage(url: string) {
  const p = await open(url);
  mark('Reading', url);
  const title = await p.title();
  const text: string = await p.evaluate(() => (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim());
  activity = null;
  return { url: p.url(), title, text: text.slice(0, 60_000) };
}

export async function screenshot(): Promise<Buffer> {
  const p = await ensure();
  return p.screenshot({ type: 'png' });
}

export async function health(timeoutMs = 5000): Promise<boolean> {
  if (!page || page.isClosed()) return true; // not running is healthy; it starts on demand
  try {
    await Promise.race([page.evaluate('1'), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), timeoutMs))]);
    return true;
  } catch { return false; }
}

/** Kill and relaunch, restoring the last URL. Used by the supervisor. */
export async function restart(reason: string) {
  const old = sessionId;
  if (old) update('computer_sessions', old, { state: 'crashed', ended_at: now(), detail: reason });
  try { await ctx?.close(); } catch { /* already dead */ }
  page = null; ctx = null; cdp = null; screencasting = false;
  await ensure();
  return { previous: old, current: sessionId, url: lastUrl };
}

/** Hang the renderer (used to demonstrate supervisor recovery). */
export function hangForDemo() {
  if (!page) return false;
  // Freeze the renderer: the page stops answering, exactly like a hung tab.
  page.evaluate('setTimeout(() => { const t = Date.now(); while (Date.now() - t < 600000) {} }, 0)').catch(() => {});
  return true;
}

// Human control: input forwarded from the Computer view.
export async function humanInput(ev: { type: string; x?: number; y?: number; key?: string; text?: string; deltaY?: number; url?: string }) {
  const p = await ensure();
  switch (ev.type) {
    case 'click': await p.mouse.click(ev.x!, ev.y!); break;
    case 'move': await p.mouse.move(ev.x!, ev.y!); break;
    case 'wheel': await p.mouse.wheel(0, ev.deltaY ?? 0); break;
    case 'key': await p.keyboard.press(ev.key!); break;
    case 'type': await p.keyboard.type(ev.text ?? ''); break;
    case 'navigate': await p.goto(ev.url!, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {}); break;
    case 'back': await p.goBack().catch(() => {}); break;
    case 'reload': await p.reload().catch(() => {}); break;
  }
}

export async function shutdown() { try { await ctx?.close(); } catch { /* ignore */ } }
