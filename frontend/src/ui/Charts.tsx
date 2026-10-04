import { useId } from "react";

const fmt2 = (v: number) => v.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Точки ряда в координатах рамки. Пустые значения пропускаются, линия рвётся. */
export function linePath(data: (number | null)[], X: (i: number) => number, Y: (v: number) => number): string {
  let d = "";
  let pen = false;
  data.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) { pen = false; return; }
    d += `${pen ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `;
    pen = true;
  });
  return d.trim();
}

/** Спарклайн: тенденция без осей. Плоский ряд — линия посередине. */
export function Spark({ data, color = "var(--c1)", width = 100, height = 30, label }: {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
  label?: string;
}) {
  if (data.length < 2) return null;
  const mn = Math.min(...data);
  const mx = Math.max(...data);
  const X = (i: number) => (i * width) / (data.length - 1);
  const Y = (v: number) => (mx === mn ? height / 2 : height - 3 - ((height - 6) * (v - mn)) / (mx - mn));
  const d = linePath(data, X, Y);
  const last = data.length - 1;
  return (
    <svg className="ui-spark" viewBox={`0 0 ${width} ${height}`} width={width} height={height}
      role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {mx > mn && <path d={`${d} L${width} ${height} L0 ${height} Z`} style={{ fill: color }} fillOpacity={0.12} />}
      <path d={d} fill="none" style={{ stroke: color }} strokeWidth={1.5} />
      <circle cx={X(last)} cy={Y(data[last])} r={2.4} style={{ fill: color }} />
    </svg>
  );
}

export interface LineSeries {
  data: (number | null)[];
  color: string;
  label: string;
  area?: boolean;
  dash?: boolean;
}

/** Линии по эпохам. `total` — сколько точек будет всего: незаполненный хвост показан полосой. */
export function LineChart({ series, total, yMin = 0, yMax = 1, ticks = [0, 0.25, 0.5, 0.75, 1],
  width = 560, height = 200, format = fmt2, label }: {
  series: LineSeries[];
  total?: number;
  yMin?: number;
  yMax?: number;
  ticks?: number[];
  width?: number;
  height?: number;
  format?: (v: number) => string;
  label: string;
}) {
  const clip = useId();
  const have = Math.max(0, ...series.map((s) => s.data.length));
  const n = Math.max(2, total ?? have);
  const pl = 36, pr = 12, pt = 10, pb = 22;
  const iw = width - pl - pr, ih = height - pt - pb;
  const X = (i: number) => pl + (iw * i) / (n - 1);
  const Y = (v: number) => pt + ih * (1 - (Math.min(yMax, Math.max(yMin, v)) - yMin) / (yMax - yMin));
  const every = Math.max(1, Math.ceil(n / 6 / 5) * 5);
  const xTicks: number[] = [];
  for (let i = 0; i < n - 1; i += every) xTicks.push(i);
  const rest = total && have > 0 && have < total ? have - 1 : null;
  return (
    <svg className="ui-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <clipPath id={clip}><rect x={pl} y={pt - 4} width={iw} height={ih + 8} /></clipPath>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={pl} x2={width - pr} y1={Y(v)} y2={Y(v)} className="ui-chart-grid" />
          <text className="ui-chart-ax" x={pl - 6} y={Y(v) + 3} textAnchor="end">{format(v)}</text>
        </g>
      ))}
      {xTicks.map((i) => <text key={i} className="ui-chart-ax" x={X(i)} y={height - 6} textAnchor="middle">{i + 1}</text>)}
      <text className="ui-chart-ax" x={X(n - 1)} y={height - 6} textAnchor="end">{n}</text>
      {rest != null && (
        <g>
          <rect x={X(rest)} y={pt} width={X(n - 1) - X(rest)} height={ih} className="ui-chart-rest" />
          <text className="ui-chart-ax" x={(X(rest) + X(n - 1)) / 2} y={pt + 14} textAnchor="middle">
            ещё {n - rest - 1}
          </text>
        </g>
      )}
      <g clipPath={`url(#${clip})`}>
        {series.map((s) => {
          const d = linePath(s.data, X, Y);
          if (!d) return null;
          const lastI = s.data.reduce<number>((acc, v, i) => (v != null && Number.isFinite(v) ? i : acc), -1);
          return (
            <g key={s.label}>
              {s.area && lastI > 0 && (
                <path d={`${d} L${X(lastI).toFixed(1)} ${Y(yMin)} L${X(0)} ${Y(yMin)} Z`}
                  style={{ fill: s.color }} fillOpacity={0.1} />
              )}
              <path d={d} fill="none" style={{ stroke: s.color }} strokeWidth={1.8} strokeLinejoin="round"
                strokeDasharray={s.dash ? "4 3" : undefined} />
              {!s.dash && lastI >= 0 && (
                <circle cx={X(lastI)} cy={Y(s.data[lastI] as number)} r={3.2}
                  style={{ fill: s.color, stroke: "var(--card)" }} strokeWidth={2} />
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
