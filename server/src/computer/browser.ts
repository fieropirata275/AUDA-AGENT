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
import { browserInstall, ensureBrowserBinary } from './browser-install.ts';

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
export const available = () => Boolean(config.chromiumPath) || process.env.AUDA_BROWSER_AUTOINSTALL !== '0';
export const status = () => ({
  available: available(),
  installing: browserInstall.state === 'installing',
  running: Boolean(page && !page.isClosed()),
  url: page && !page.isClosed() ? page.url() : lastUrl,
  sessionId,
  activity,
});

export async function ensure(): Promise<Page> {
  if (page && !page.isClosed()) return page;
  if (starting) return starting;
  starting = (async () => {
    const executablePath = await ensureBrowserBinary();
    const locale = browserLocale();
    ctx = await chromium.launchPersistentContext(config.browserProfileDir, {
      executablePath,
      headless: true,
      viewport: VIEWPORT,
      locale,
      args: ['--no-first-run', '--disable-dev-shm-usage', '--no-default-browser-check', `--lang=${locale}`],
    });
    page = ctx.pages()[0] ?? (await ctx.newPage());
    await presentAsChrome(page, locale);
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

// One page, many agents: serialise use so parallel tasks can't navigate under each other.
let chain: Promise<unknown> = Promise.resolve();
export const browserQueue = { waiting: 0 };
export function withBrowser<T>(fn: () => Promise<T>): Promise<T> {
  browserQueue.waiting++;
  const run = chain.then(fn, fn).finally(() => { browserQueue.waiting--; });
  chain = run.catch(() => {});
  return run;
}

export async function open(url: string) {
  const p = await ensure();
  mark('Opening', url);
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await p.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  return p;
}

/** The browser's language: AUDA_BROWSER_LOCALE, else the machine's (sites answer in it — prices in euros on a Spanish machine). */
export function browserLocale() {
  const l = process.env.AUDA_BROWSER_LOCALE || Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  return /^[a-z]{2}(-[A-Z]{2})?$/.test(l) ? l : 'en-US';
}

/**
 * Headless Chrome announces itself as "HeadlessChrome", and many shops answer that with an error page. Present the
 * same browser as the regular Chrome it is, in the machine's language.
 */
async function presentAsChrome(p: Page, locale: string) {
  try {
    const ua = String(await p.evaluate('navigator.userAgent')).replace('HeadlessChrome', 'Chrome');
    const s = await p.context().newCDPSession(p);
    await s.send('Emulation.setUserAgentOverride', { userAgent: ua, acceptLanguage: `${locale},${locale.split('-')[0]};q=0.9,en;q=0.8` });
  } catch (e) { log.warn('user agent override failed', String(e)); }
}

// Cookie/consent banners hide the page (and its prices) until someone answers them. Accept, in common languages.
const CONSENT = /^(accept( all)?( cookies)?|allow( all)?( cookies)?|agree|i agree|got it|ok|aceptar( todo| todas| cookies| y cerrar)?|acepto|permitir( todas)?|accepter( tout)?|tout accepter|j'accepte|alle akzeptieren|akzeptieren|zustimmen|accetta( tutto)?|accetto|aceitar( tudo)?|alles accepteren|accepteren)$/i;
async function dismissConsent(p: Page) {
  for (const frame of p.frames().slice(0, 6)) {
    try {
      const buttons = frame.locator('button, [role=button], a[role=button], input[type=button], input[type=submit]');
      const n = Math.min(await buttons.count(), 60);
      for (let i = 0; i < n; i++) {
        const b = buttons.nth(i);
        const label = ((await b.innerText({ timeout: 300 }).catch(() => '')) || (await b.getAttribute('value').catch(() => '')) || '').trim().replace(/\s+/g, ' ');
        if (label.length <= 40 && CONSENT.test(label) && await b.isVisible().catch(() => false)) {
          await b.click({ timeout: 2000 }).catch(() => {});
          await p.waitForTimeout(400);
          return true;
        }
      }
    } catch { /* frame went away */ }
  }
  return false;
}

/** Scroll down a few screens so lazy-loaded content (prices, listings, reviews) renders, then back to the top. */
async function loadLazy(p: Page) {
  try {
    for (let i = 0; i < 4; i++) { await p.mouse.wheel(0, 1600); await p.waitForTimeout(250); }
    await p.evaluate(() => window.scrollTo(0, 0));
  } catch { /* page navigated */ }
}

export interface PageRead { url: string; title: string; text: string; links: { text: string; url: string }[]; truncated: boolean; chars: number }

const EXTRACT_SCRIPT = `(() => {
  var visible = function (el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  var mains = Array.prototype.slice.call(document.querySelectorAll('main, [role=main], article, #main, #content')).filter(visible)
    .sort(function (a, b) { return b.innerText.length - a.innerText.length; });
  var body = document.body ? document.body.innerText : '';
  var text = mains[0] && (mains[0].innerText.length >= 100 || mains[0].innerText.length > body.length * 0.3) ? mains[0].innerText : body;
  var seen = {}, links = [];
  var anchors = document.querySelectorAll('a[href]');
  for (var i = 0; i < anchors.length && links.length < 400; i++) {
    var a = anchors[i];
    var t = (a.innerText || a.getAttribute('aria-label') || a.title || '').trim().replace(/\\s+/g, ' ');
    if (!t || t.length > 120 || !/^https?:/.test(a.href) || seen[a.href] || !visible(a)) continue;
    seen[a.href] = true; links.push({ text: t, url: a.href });
  }
  return { text: text, links: links };
})()`;

const MAX_CHARS = () => Number(process.env.AUDA_BROWSE_MAX_CHARS ?? 12_000);

/**
 * What an agent needs from a page, compactly: the main text (from <main>/<article> when the page has one), the links
 * it could follow next, and — with `focus` — only the passages that mention what it's looking for. Whole pages can be
 * 60k+ characters of menus and footers; sending them all fills a model's context in a few pages.
 */
async function extract(p: Page, focus?: string): Promise<PageRead> {
  // Passed as source text: tsx/esbuild wraps named functions in a `__name` helper that doesn't exist inside the page.
  const raw = await p.evaluate(EXTRACT_SCRIPT) as { text: string; links: { text: string; url: string }[] };
  const lines = raw.text.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
  const full = lines.join('\n');
  let text = full;
  const terms = (focus ?? '').toLowerCase().split(/[,;]|\s+/).map((t) => t.trim()).filter((t) => t.length > 1);
  if (terms.length) {
    const keep = new Set<number>();
    lines.forEach((l, i) => { const low = l.toLowerCase(); if (terms.some((t) => low.includes(t))) for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 3); j++) keep.add(j); });
    const picked = [...keep].sort((a, b) => a - b);
    const parts: string[] = [];
    let prev = -2;
    const clip = (l: string, n: number) => l.length > n ? `${l.slice(0, n)}…` : l;
    for (const i of picked) {
      if (i !== prev + 1) parts.push('…');
      const low = lines[i].toLowerCase();
      parts.push(clip(lines[i], terms.some((t) => low.includes(t)) ? 600 : 200)); // context lines stay short
      prev = i;
    }
    text = picked.length ? `[passages mentioning: ${terms.join(', ')}]\n${parts.join('\n')}` : `[nothing on this page mentions: ${terms.join(', ')} — the start of the page follows]\n${full}`;
  }
  const max = MAX_CHARS();
  const truncated = text.length > max;
  const linkList = raw.links.filter((l) => !terms.length || terms.some((t) => l.text.toLowerCase().includes(t))).slice(0, 40);
  return { url: p.url(), title: await p.title(), text: truncated ? text.slice(0, max) + '\n…[truncated — use focus to see a specific part]' : text, links: linkList.length ? linkList : raw.links.slice(0, 40), truncated, chars: full.length };
}

async function settle(p: Page) {
  await p.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  if (await dismissConsent(p)) await p.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
  await loadLazy(p);
}

export function readPage(url: string, focus?: string) { return withBrowser(() => readPageUnlocked(url, focus)); }
async function readPageUnlocked(url: string, focus?: string) {
  const p = await open(url);
  mark('Reading', url);
  await settle(p);
  const r = await extract(p, focus);
  activity = null;
  return r;
}

export type BrowserAction = { action: 'click' | 'type' | 'press' | 'scroll' | 'back' | 'read'; target?: string; value?: string; submit?: boolean; focus?: string };

/** Clicks and typing that would buy, send, delete or sign up are submissions: they go through approval. */
export const isSubmission = (a: BrowserAction) =>
  (a.action === 'click' && /\b(buy|purchase|pay|checkout|check out|place (your )?order|order now|confirm|submit|send|subscribe|sign up|register|delete|remove account|comprar|pagar|tramitar|realizar pedido|confirmar|enviar|suscrib|registrar|eliminar|acheter|payer|kaufen|bezahlen|bestellen)\b/i.test(a.target ?? ''))
  || (a.action === 'type' && !!a.submit && /pass(word)?|card|tarjeta|cvv|iban|contraseña/i.test(a.target ?? ''));

/** Find an element by what a person would call it: its text, label, placeholder or role name — or a CSS selector. */
async function locate(p: Page, target: string, kind: 'click' | 'field') {
  const t = target.trim();
  const candidates = kind === 'field'
    ? [p.getByLabel(t, { exact: false }), p.getByPlaceholder(t, { exact: false }), p.getByRole('searchbox', { name: t }), p.getByRole('textbox', { name: t }),
       ...(/^search|buscar|^q$/i.test(t) ? [p.locator('input[type=search], input[name=q], input[name*=search i], input[id*=search i], input[aria-label*=search i], input[aria-label*=buscar i]')] : [])]
    : [p.getByRole('button', { name: t }), p.getByRole('link', { name: t }), p.getByRole('tab', { name: t }), p.getByRole('menuitem', { name: t }), p.getByText(t, { exact: false })];
  if (/^[#.\[]|^[a-z]+[#.\[]/i.test(t)) candidates.unshift(p.locator(t));
  for (const c of candidates) {
    try {
      const n = await c.count();
      for (let i = 0; i < Math.min(n, 5); i++) if (await c.nth(i).isVisible()) return c.nth(i);
    } catch { /* not a valid selector for this strategy */ }
  }
  throw new Error(`Couldn’t find ${kind === 'field' ? 'a field' : 'anything to click'} matching “${t}” on ${p.url()}. Read the page (or its links) and use the exact visible text.`);
}

/** Act on the current page like a person, then return what the page shows now. */
export function act(a: BrowserAction) { return withBrowser(() => actUnlocked(a)); }
async function actUnlocked(a: BrowserAction): Promise<PageRead & { did: string }> {
  const p = await ensure();
  let did = '';
  switch (a.action) {
    case 'click': {
      const el = await locate(p, a.target ?? '', 'click');
      mark('Clicking', p.url());
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await Promise.all([p.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {}), el.click({ timeout: 10_000 })]);
      did = `clicked “${a.target}”`;
      break;
    }
    case 'type': {
      const el = await locate(p, a.target ?? 'search', 'field');
      mark('Typing', p.url());
      await el.fill(a.value ?? '', { timeout: 10_000 });
      if (a.submit) await Promise.all([p.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {}), el.press('Enter')]);
      did = `typed “${a.value}” into ${a.target}${a.submit ? ' and pressed Enter' : ''}`;
      break;
    }
    case 'press': await p.keyboard.press(a.value || a.target || 'Enter'); did = `pressed ${a.value || a.target || 'Enter'}`; break;
    case 'scroll': await p.mouse.wheel(0, /up/i.test(a.target ?? a.value ?? '') ? -2400 : 2400); did = 'scrolled'; break;
    case 'back': await p.goBack({ timeout: 15_000 }).catch(() => {}); did = 'went back'; break;
    case 'read': did = 'read the page'; break;
  }
  if (a.action !== 'scroll' && a.action !== 'read') await settle(p);
  else await p.waitForTimeout(400);
  const r = await extract(p, a.focus);
  activity = null;
  return { ...r, did };
}

export function screenshot(): Promise<Buffer> {
  return withBrowser(async () => (await ensure()).screenshot({ type: 'png' }));
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
