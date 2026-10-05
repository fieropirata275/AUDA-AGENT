/**
 * Web search that works with any model (Claude's server-side search is only
 * available on Anthropic models). Uses a self-hosted SearXNG when
 * AUDA_SEARXNG_URL is set, otherwise DuckDuckGo's HTML endpoint. Results are
 * untrusted data; the agent reads the pages themselves with browse/fetch.
 */
export interface SearchResult { title: string; url: string; snippet: string }

const decode = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

export async function searchWeb(query: string, limit = 8): Promise<SearchResult[]> {
  const q = query.trim().slice(0, 300);
  if (!q) throw new Error('Give a search query');
  const searx = process.env.AUDA_SEARXNG_URL;
  if (searx) {
    const r = await fetch(`${searx.replace(/\/$/, '')}/search?q=${encodeURIComponent(q)}&format=json`, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } });
    if (!r.ok) throw Object.assign(new Error(`search failed: HTTP ${r.status}`), { status: r.status });
    const j: any = await r.json();
    return (j.results ?? []).slice(0, limit).map((x: any) => ({ title: String(x.title ?? ''), url: String(x.url ?? ''), snippet: String(x.content ?? '') }));
  }
  const base = process.env.AUDA_SEARCH_URL ?? 'https://html.duckduckgo.com/html/';
  const r = await fetch(`${base}?q=${encodeURIComponent(q)}`, {
    signal: AbortSignal.timeout(20_000),
    headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 AUDA', accept: 'text/html' },
  });
  if (!r.ok) throw Object.assign(new Error(`search failed: HTTP ${r.status}`), { status: r.status });
  const html = await r.text();
  const out: SearchResult[] = [];
  // Each result's snippet is searched for only between its link and the next result's link.
  const links = [...html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  for (let i = 0; i < links.length && out.length < limit; i++) {
    const m = links[i];
    const segment = html.slice(m.index! + m[0].length, links[i + 1]?.index ?? html.length);
    const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/.exec(segment)?.[1];
    let url = m[1].replace(/&amp;/g, '&');
    const redirect = /[?&]uddg=([^&]+)/.exec(url);
    if (redirect) url = decodeURIComponent(redirect[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https?:/.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    out.push({ title: decode(m[2]), url, snippet: decode(snippet ?? '') });
  }
  return out;
}
