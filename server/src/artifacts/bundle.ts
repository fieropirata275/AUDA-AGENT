/**
 * Turn work an agent left in its workspace into a self-contained artifact.
 * An HTML page usually references its own CSS, JS and images by relative path;
 * an artifact is a single file served on its own, so those are inlined
 * (stylesheets as <style>, scripts as <script>, images as data: URIs).
 */
import fs from 'node:fs';
import path from 'node:path';

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const isLocal = (ref: string) => !!ref && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(ref);

/** Inline a page's local stylesheets, scripts and images. Returns the page and the files it absorbed. */
export function bundleHtml(absHtml: string, within: string): { html: string; inlined: string[] } {
  const dir = path.dirname(absHtml);
  const inlined: string[] = [];
  const local = (ref: string) => {
    const clean = decodeURIComponent(ref.split(/[?#]/)[0]);
    const abs = path.resolve(dir, clean);
    if (!abs.startsWith(within + path.sep) && abs !== within) return null;
    try { return fs.statSync(abs).isFile() && fs.statSync(abs).size < 8 * 1024 * 1024 ? abs : null; } catch { return null; }
  };
  const dataUri = (abs: string) => `data:${MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream'};base64,${fs.readFileSync(abs).toString('base64')}`;
  // url(...) inside CSS, resolved against the stylesheet's own folder
  const cssUrls = (css: string, base: string) => css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, ref) => {
    if (!isLocal(ref)) return m;
    const abs = path.resolve(base, decodeURIComponent(ref.split(/[?#]/)[0]));
    try { if (abs.startsWith(within + path.sep) && fs.statSync(abs).isFile()) { inlined.push(abs); return `url("${dataUri(abs)}")`; } } catch { /* missing */ }
    return m;
  });
  let html = fs.readFileSync(absHtml, 'utf8');
  html = html.replace(/<link\b[^>]*\brel=["']?stylesheet["']?[^>]*>/gi, (tag) => {
    const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1];
    const abs = href && isLocal(href) ? local(href) : null;
    if (!abs) return tag;
    inlined.push(abs);
    return `<style>\n${cssUrls(fs.readFileSync(abs, 'utf8'), path.dirname(abs))}\n</style>`;
  });
  html = html.replace(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, a, src, b) => {
    const abs = isLocal(src) ? local(src) : null;
    if (!abs) return tag;
    inlined.push(abs);
    const attrs = `${a} ${b}`.replace(/\s+/g, ' ').trim();
    return `<script${attrs ? ` ${attrs}` : ''}>\n${fs.readFileSync(abs, 'utf8').replace(/<\/script/gi, '<\\/script')}\n</script>`;
  });
  html = html.replace(/(<(?:img|source|video|audio)\b[^>]*\b(?:src|poster)=["'])([^"']+)(["'])/gi, (m, pre, src, post) => {
    const abs = isLocal(src) ? local(src) : null;
    if (!abs || !MIME[path.extname(abs).toLowerCase()]) return m;
    inlined.push(abs);
    return `${pre}${dataUri(abs)}${post}`;
  });
  html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (m, css) => m.replace(css, cssUrls(css, dir)));
  return { html, inlined: [...new Set(inlined)] };
}

/** Files worth handing to the user when a task ends (not scratch, caches or dependencies). */
export const DELIVERABLE = /\.(html?|md|markdown|txt|csv|tsv|json|ya?ml|xml|pdf|docx|xlsx|pptx|odt|png|jpe?g|gif|webp|svg|py|js|mjs|ts|tsx|jsx|css|sh|ps1|sql|ipynb|zip)$/i;
export const SKIP_PATH = /(^|[\\/])(node_modules|\.git|\.venv|venv|__pycache__|\.cache|dist|build|\.next|artifacts)([\\/]|$)/;
