/**
 * Charts as clean, self-contained SVG — for PDFs, HTML decks and the UI.
 * (PowerPoint gets native, editable charts from the same spec in slides.ts.)
 *
 * Spec: { type: 'bar'|'hbar'|'line'|'area'|'pie'|'donut', title?, labels: string[],
 *         series: [{ name, values: number[] }], unit?, stacked? }
 */
export interface ChartSpec {
  type: 'bar' | 'hbar' | 'line' | 'area' | 'pie' | 'donut';
  title?: string;
  labels: string[];
  series: { name: string; values: number[] }[];
  unit?: string;
  stacked?: boolean;
}

export const PALETTE = ['#c25e2c', '#2f8f6a', '#5b7cfa', '#d4a72c', '#9b5de5', '#00a6c0', '#e5484d', '#7a6f62'];
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function validateChart(c: any): ChartSpec {
  if (!c || typeof c !== 'object') throw new Error('chart must be an object');
  const type = ['bar', 'hbar', 'line', 'area', 'pie', 'donut'].includes(c.type) ? c.type : 'bar';
  const labels = Array.isArray(c.labels) ? c.labels.map(String).slice(0, 60) : [];
  let series = Array.isArray(c.series) ? c.series : Array.isArray(c.values) ? [{ name: c.title ?? 'Value', values: c.values }] : [];
  series = series.slice(0, 8).map((s: any, i: number) => ({ name: String(s?.name ?? `Series ${i + 1}`), values: (Array.isArray(s?.values) ? s.values : []).map((v: any) => Number(v) || 0) }));
  if (!labels.length || !series.length) throw new Error('chart needs labels and at least one series with values');
  return { type, title: c.title ? String(c.title) : undefined, labels, series, unit: c.unit ? String(c.unit) : undefined, stacked: !!c.stacked };
}

const fmt = (v: number, unit?: string) => {
  const a = Math.abs(v);
  const n = a >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : a >= 1e4 ? `${(v / 1e3).toFixed(0)}k` : Number.isInteger(v) ? String(v) : v.toFixed(1);
  return unit ? (unit === '%' ? `${n}%` : unit.length <= 2 && /[$€£¥]/.test(unit) ? `${unit}${n}` : `${n} ${unit}`) : n;
};
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/** Render a chart spec to an SVG string. `ink` colours text for the target background. */
export function chartSvg(spec: ChartSpec, o: { width?: number; height?: number; ink?: string; muted?: string; grid?: string; font?: string } = {}): string {
  const c = validateChart(spec);
  const W = o.width ?? 720, H = o.height ?? 400;
  const ink = o.ink ?? '#2a2622', muted = o.muted ?? '#8a8178', grid = o.grid ?? '#e6e0d6';
  const font = o.font ?? "'Instrument Sans Variable','Instrument Sans',system-ui,sans-serif";
  const top = c.title ? 44 : 16;
  const legend = c.series.length > 1 || c.type === 'pie' || c.type === 'donut';
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${esc(font)}" role="img" aria-label="${esc(c.title ?? 'Chart')}">`];
  if (c.title) out.push(`<text x="0" y="24" font-size="17" font-weight="650" fill="${ink}">${esc(c.title)}</text>`);

  if (c.type === 'pie' || c.type === 'donut') {
    const vals = c.series[0].values.map((v) => Math.max(0, v));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const r = Math.min(W * 0.32, (H - top - 16) / 2), cx = r + 8, cy = top + (H - top) / 2;
    let a0 = -Math.PI / 2;
    vals.forEach((v, i) => {
      const a1 = a0 + (v / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (a: number, rr: number) => `${(cx + rr * Math.cos(a)).toFixed(2)} ${(cy + rr * Math.sin(a)).toFixed(2)}`;
      const inner = c.type === 'donut' ? r * 0.58 : 0;
      const d = inner
        ? `M${p(a0, r)} A${r} ${r} 0 ${large} 1 ${p(a1, r)} L${p(a1, inner)} A${inner} ${inner} 0 ${large} 0 ${p(a0, inner)} Z`
        : `M${cx} ${cy} L${p(a0, r)} A${r} ${r} 0 ${large} 1 ${p(a1, r)} Z`;
      if (v > 0) out.push(`<path d="${d}" fill="${PALETTE[i % PALETTE.length]}" stroke="#fff" stroke-width="2"/>`);
      a0 = a1;
    });
    if (c.type === 'donut') out.push(`<text x="${cx}" y="${cy + 6}" text-anchor="middle" font-size="20" font-weight="650" fill="${ink}">${esc(fmt(total, c.unit))}</text>`);
    const lx = cx + r + 32;
    c.labels.slice(0, vals.length).forEach((l, i) => {
      const y = top + 20 + i * 26;
      out.push(`<rect x="${lx}" y="${y - 11}" width="12" height="12" rx="3" fill="${PALETTE[i % PALETTE.length]}"/><text x="${lx + 20}" y="${y}" font-size="13" fill="${ink}">${esc(l)} <tspan fill="${muted}">${c.unit === '%' ? esc(fmt(vals[i], c.unit)) : `${esc(fmt(vals[i], c.unit))} · ${Math.round((vals[i] / total) * 100)}%`}</tspan></text>`);
    });
    out.push('</svg>');
    return out.join('');
  }

  const n = c.labels.length;
  const totals = c.labels.map((_, i) => c.series.reduce((s, x) => s + Math.max(0, x.values[i] ?? 0), 0));
  const maxV = niceMax(c.stacked && (c.type === 'bar' || c.type === 'hbar' || c.type === 'area') ? Math.max(...totals) : Math.max(...c.series.flatMap((s) => s.values), 0));
  const legendH = legend ? 28 : 0;
  if (c.type === 'hbar') {
    const left = Math.min(220, 12 + Math.max(...c.labels.map((l) => l.length)) * 7.2), right = 56;
    const plotW = W - left - right, plotH = H - top - 10 - legendH;
    const band = plotH / n, bh = Math.max(4, Math.min(28, band * 0.7 / (c.stacked ? 1 : c.series.length)));
    for (let t = 0; t <= 4; t++) { const x = left + (plotW * t) / 4; out.push(`<line x1="${x}" y1="${top}" x2="${x}" y2="${top + plotH}" stroke="${grid}"/><text x="${x}" y="${top + plotH + 14}" font-size="11" fill="${muted}" text-anchor="middle">${esc(fmt((maxV * t) / 4, c.unit))}</text>`); }
    c.labels.forEach((l, i) => {
      const y0 = top + band * i + (band - bh * (c.stacked ? 1 : c.series.length)) / 2;
      out.push(`<text x="${left - 8}" y="${y0 + (bh * (c.stacked ? 1 : c.series.length)) / 2 + 4}" font-size="12" fill="${ink}" text-anchor="end">${esc(l)}</text>`);
      let acc = 0;
      c.series.forEach((s, k) => {
        const v = Math.max(0, s.values[i] ?? 0), w = (v / maxV) * plotW;
        const x = left + (c.stacked ? (acc / maxV) * plotW : 0), y = c.stacked ? y0 : y0 + k * bh;
        out.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, w).toFixed(1)}" height="${(bh - 2).toFixed(1)}" rx="3" fill="${PALETTE[k % PALETTE.length]}"/>`);
        if (!c.stacked) out.push(`<text x="${(x + w + 5).toFixed(1)}" y="${(y + bh / 2 + 3).toFixed(1)}" font-size="11" fill="${muted}">${esc(fmt(v, c.unit))}</text>`);
        acc += v;
      });
    });
  } else {
    const left = 52, right = 12, bottom = 34 + legendH;
    const plotW = W - left - right, plotH = H - top - bottom;
    for (let t = 0; t <= 4; t++) { const y = top + plotH - (plotH * t) / 4; out.push(`<line x1="${left}" y1="${y}" x2="${W - right}" y2="${y}" stroke="${grid}"/><text x="${left - 8}" y="${y + 4}" font-size="11" fill="${muted}" text-anchor="end">${esc(fmt((maxV * t) / 4, c.unit))}</text>`); }
    const step = plotW / n;
    const every = Math.ceil(n / 12);
    c.labels.forEach((l, i) => { if (i % every === 0) out.push(`<text x="${(left + step * i + step / 2).toFixed(1)}" y="${top + plotH + 18}" font-size="11" fill="${muted}" text-anchor="middle">${esc(l.length > 14 ? l.slice(0, 13) + '…' : l)}</text>`); });
    const yOf = (v: number) => top + plotH - (Math.max(0, v) / maxV) * plotH;
    if (c.type === 'bar') {
      const groupW = step * 0.72, bw = c.stacked ? groupW : groupW / c.series.length;
      c.labels.forEach((_, i) => {
        let acc = 0;
        c.series.forEach((s, k) => {
          const v = Math.max(0, s.values[i] ?? 0), h = (v / maxV) * plotH;
          const x = left + step * i + (step - groupW) / 2 + (c.stacked ? 0 : k * bw);
          const y = top + plotH - h - (c.stacked ? (acc / maxV) * plotH : 0);
          out.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${PALETTE[k % PALETTE.length]}"/>`);
          if (!c.stacked && c.series.length === 1 && n <= 12) out.push(`<text x="${(x + bw / 2 - 1).toFixed(1)}" y="${(y - 5).toFixed(1)}" font-size="11" fill="${muted}" text-anchor="middle">${esc(fmt(v, c.unit))}</text>`);
          acc += v;
        });
      });
    } else {
      const base = new Array(n).fill(0);
      c.series.forEach((s, k) => {
        const pts = s.values.slice(0, n).map((v, i) => { const val = c.stacked && c.type === 'area' ? base[i] + Math.max(0, v) : v; return [left + step * i + step / 2, yOf(val)] as const; });
        const col = PALETTE[k % PALETTE.length];
        const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('');
        if (c.type === 'area') {
          const floor = c.stacked ? pts.map((p, i) => [p[0], yOf(base[i])] as const).reverse() : [[pts[pts.length - 1][0], top + plotH], [pts[0][0], top + plotH]] as const;
          out.push(`<path d="${line}${floor.map((p) => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('')}Z" fill="${col}" fill-opacity="0.22"/>`);
          if (c.stacked) s.values.slice(0, n).forEach((v, i) => { base[i] += Math.max(0, v); });
        }
        out.push(`<path d="${line}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`);
        if (n <= 24) pts.forEach((p) => out.push(`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.2" fill="#fff" stroke="${col}" stroke-width="2"/>`));
      });
    }
  }
  if (legend) {
    let x = c.type === 'hbar' ? 0 : 52;
    c.series.forEach((s, k) => {
      out.push(`<rect x="${x}" y="${H - 16}" width="12" height="12" rx="3" fill="${PALETTE[k % PALETTE.length]}"/><text x="${x + 18}" y="${H - 6}" font-size="12" fill="${ink}">${esc(s.name)}</text>`);
      x += 30 + s.name.length * 7;
    });
  }
  out.push('</svg>');
  return out.join('');
}
