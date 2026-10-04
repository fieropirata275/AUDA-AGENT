/** Tiny, safe Markdown renderer for AUDA's own reports (no HTML passthrough). */
import { Fragment, type ReactNode } from 'react';

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    out.push(t.startsWith('**') ? <strong key={k++}>{t.slice(2, -2)}</strong> : t.startsWith('`') ? <code key={k++}>{t.slice(1, -1)}</code> : <em key={k++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  let list: string[] = [], para: string[] = [], k = 0;
  const flush = () => {
    if (para.length) { blocks.push(<p key={k++}>{inline(para.join(' '))}</p>); para = []; }
    if (list.length) { blocks.push(<ul key={k++}>{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>); list = []; }
  };
  for (const l of lines) {
    const h = /^(#{1,3})\s+(.*)/.exec(l);
    if (h) { flush(); const T = (`h${h[1].length + 1}`) as 'h2'; blocks.push(<T key={k++}>{inline(h[2])}</T>); continue; }
    if (/^\s*[-*+]\s+/.test(l)) { if (para.length) { blocks.push(<p key={k++}>{inline(para.join(' '))}</p>); para = []; } list.push(l.replace(/^\s*[-*+]\s+/, '')); continue; }
    if (!l.trim()) { flush(); continue; }
    if (list.length) flush();
    para.push(l);
  }
  flush();
  return <div className="md">{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>;
}
