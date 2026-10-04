/** Honest sparkline: draws only observed samples, with the threshold line. */
export function Sparkline({ points, threshold, width = 160, height = 34, max = 100 }: { points: [number, number][]; threshold?: number; width?: number; height?: number; max?: number }) {
  if (!points || points.length < 2) return null;
  const t0 = points[0][0], t1 = points[points.length - 1][0] || t0 + 1;
  const top = Math.max(max, ...points.map((p) => p[1]));
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * (width - 4) + 2;
  const y = (v: number) => height - 3 - (v / top) * (height - 6);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join('');
  const last = points[points.length - 1];
  const over = threshold != null && last[1] >= threshold;
  return (
    <svg width={width} height={height} className="spark" aria-label={`latest ${last[1]}%`}>
      {threshold != null && <line x1="0" x2={width} y1={y(threshold)} y2={y(threshold)} stroke="var(--attention)" strokeDasharray="3 3" strokeWidth="1" opacity="0.6" />}
      <path d={`${d}L${x(last[0])} ${height}L${x(t0)} ${height}Z`} fill={over ? 'var(--attention-soft)' : 'var(--accent-soft)'} />
      <path d={d} fill="none" stroke={over ? 'var(--attention)' : 'var(--accent)'} strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx={x(last[0])} cy={y(last[1])} r="2.6" fill={over ? 'var(--attention)' : 'var(--accent)'} />
    </svg>
  );
}
