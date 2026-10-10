/**
 * Markdown for AUDA's replies and reports: GitHub-flavoured (tables, task lists, fenced code), links open in a new
 * tab, code blocks get a copy button. Raw HTML in the text is shown as text, never rendered — replies can carry
 * content from web pages.
 */
import { useMemo, type MouseEvent } from 'react';
import { Marked } from 'marked';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const md = new Marked({ gfm: true, breaks: true });
md.use({
  renderer: {
    html({ text }) { return esc(text); },
    link({ href, title, tokens }) {
      const safe = /^(https?:|mailto:|#|\/)/i.test(href ?? '') ? href : '#';
      return `<a href="${esc(safe ?? '#')}"${title ? ` title="${esc(title)}"` : ''} target="_blank" rel="noopener noreferrer">${this.parser.parseInline(tokens)}</a>`;
    },
    image({ href, text }) {
      const safe = /^(https?:|\/api\/artifacts\/)/i.test(href ?? '') ? href : '';
      return safe ? `<img src="${esc(safe)}" alt="${esc(text ?? '')}" loading="lazy">` : esc(text ?? '');
    },
    code({ text, lang }) {
      return `<div class="md-code"><div class="md-code-bar"><span>${esc(lang || 'code')}</span><button type="button" class="md-copy">Copy</button></div><pre><code>${esc(text)}</code></pre></div>`;
    },
    table(token) {
      const head = token.header.map((c, i) => `<th${token.align[i] ? ` style="text-align:${token.align[i]}"` : ''}>${this.parser.parseInline(c.tokens)}</th>`).join('');
      const body = token.rows.map((r) => `<tr>${r.map((c, i) => `<td${token.align[i] ? ` style="text-align:${token.align[i]}"` : ''}>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`).join('');
      return `<div class="md-table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    },
  },
});

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => md.parse(text ?? '', { async: false }) as string, [text]);
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const b = (e.target as HTMLElement).closest('.md-copy');
    if (!b) return;
    const code = b.closest('.md-code')?.querySelector('code')?.textContent ?? '';
    void navigator.clipboard?.writeText(code);
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = 'Copy'; }, 1400);
  };
  return <div className={`md ${className ?? ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Plain text from Markdown, for previews in cards (no symbols, no table pipes). */
export function plainText(s: string) {
  return (s ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|?[\s:-]+\|[\s|:-]*$/gm, ' ')
    .replace(/\|/g, ' · ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
