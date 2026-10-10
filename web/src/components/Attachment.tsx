/**
 * A file in a chat reply, shown the way it is best understood: images and charts inline, web pages as a live
 * preview, PDFs in a viewer, code and text as a peek, Office files as a card that opens the full preview.
 */
import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { openSheet } from './ui';
import { Markdown } from './Markdown';
import type { Artifact } from '../lib/types';

const raw = (a: Artifact, download = false) => `/api/artifacts/${a.id}/raw${download ? '?download=1' : ''}`;
const size = (b: number) => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`;
const ext = (n: string) => (n.split('.').pop() ?? '').toLowerCase();
const TEXTY = /^(md|markdown|txt|csv|tsv|json|py|js|mjs|ts|tsx|jsx|css|sh|ps1|sql|yaml|yml|xml|log)$/;
const KIND: Record<string, string> = { pdf: 'PDF', pptx: 'Presentation', docx: 'Word document', xlsx: 'Spreadsheet', csv: 'CSV', md: 'Markdown', py: 'Python', js: 'JavaScript', ts: 'TypeScript', html: 'Web page', json: 'JSON', txt: 'Text', zip: 'Archive' };

function Head({ a, children }: { a: Artifact; children?: React.ReactNode }) {
  const e = ext(a.name);
  return (
    <div className="att-head">
      <span className={`file-ico ft-${e}`}>{e.toUpperCase().slice(0, 4)}</span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ellipsis att-name">{a.name}</div>
        <div className="small faint">{KIND[e] ?? a.mime.split('/').pop()} · {size(a.size)}</div>
      </div>
      {children}
      <button className="btn sm ghost" onClick={() => openSheet({ type: 'artifact', id: a.id })}>Open</button>
      <a className="btn sm ghost" href={raw(a, true)} download>Download</a>
    </div>
  );
}

function TextPeek({ a }: { a: Artifact }) {
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { void fetch(raw(a)).then((r) => r.text()).then((t) => setText(t)).catch(() => setText('')); }, [a.id]);
  if (text == null) return null;
  const lines = text.split('\n');
  const shown = open ? text : lines.slice(0, 14).join('\n');
  const e = ext(a.name);
  return (
    <div className="att-peek">
      {e === 'md' || e === 'markdown' ? <Markdown text={shown} /> : <pre><code>{shown}</code></pre>}
      {lines.length > 14 && <button className="att-more" onClick={() => setOpen(!open)}>{open ? 'Show less' : `Show all ${lines.length} lines`}</button>}
    </div>
  );
}

export function Attachment({ id }: { id: string }) {
  const a = useStore().artifacts[id];
  if (!a) return null;
  const e = ext(a.name);
  if (a.mime.startsWith('image/')) {
    return (
      <figure className="att att-image">
        <button className="att-imgbtn" onClick={() => openSheet({ type: 'artifact', id: a.id })} title={a.why}><img src={raw(a)} alt={a.why || a.name} loading="lazy" /></button>
        <figcaption className="small faint">{a.why && a.why !== a.name ? a.why : a.name} · <a href={raw(a, true)} download>Download</a></figcaption>
      </figure>
    );
  }
  if (e === 'html' || e === 'htm') {
    return (
      <div className="att">
        <Head a={a}><a className="btn sm ghost" href={raw(a)} target="_blank" rel="noreferrer">Full screen</a></Head>
        <iframe className="att-frame" src={raw(a)} sandbox="allow-scripts" title={a.name} loading="lazy" />
      </div>
    );
  }
  if (e === 'pdf') {
    return (
      <div className="att">
        <Head a={a} />
        <iframe className="att-frame pdf" src={`${raw(a)}#view=FitH&toolbar=0`} title={a.name} loading="lazy" />
      </div>
    );
  }
  return (
    <div className="att">
      <Head a={a} />
      {TEXTY.test(e) && a.size < 400_000 && <TextPeek a={a} />}
    </div>
  );
}
