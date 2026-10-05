// Карточки страницы прогона: метрики и потери по эпохам, матрица ошибок, классы, кривые по порогу.

import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { ClassMetric, CurveSeries, EpochRow, PerClass } from "../../../api/runs";
import { Card, Legend, LineChart, Notice, Seg, Swatch, Table, cx, linePath } from "../../../ui";
import type { LineSeries } from "../../../ui";
import { count, pct } from "../../ru";
import { confusionView, curveLabel, dec, topConfusions } from "./runs";
import type { ConfusionView } from "./runs";

/** Цвет класса проекта по имени; нет такого — серый образец. */
export type ColorOf = (name: string) => string | undefined;

/** Ряд значения по эпохам: индекс — эпоха минус один, пропуски — null. */
function series(epochs: EpochRow[], key: string, total: number): (number | null)[] {
  const out: (number | null)[] = Array.from({ length: Math.max(total, epochs.length ? epochs[epochs.length - 1].epoch : 0) }, () => null);
  for (const e of epochs) {
    const v = e.metrics?.[key];
    if (typeof v === "number" && Number.isFinite(v)) out[e.epoch - 1] = v;
  }
  return out;
}

const has = (epochs: EpochRow[], key: string) => epochs.some((e) => typeof e.metrics?.[key] === "number");

const METRICS = [
  { key: "metrics/mAP50(B)", label: "mAP50", color: "var(--c1)", area: true },
  { key: "metrics/mAP50-95(B)", label: "mAP50-95", color: "var(--c2)" },
  { key: "metrics/precision(B)", label: "Точность", color: "var(--c3)" },
  { key: "metrics/recall(B)", label: "Полнота", color: "var(--c4)" },
  { key: "metrics/mAP50(M)", label: "mAP50 маски", color: "var(--c5)" },
];

export function MetricsCard({ epochs, total }: { epochs: EpochRow[]; total: number }) {
  const lines: LineSeries[] = METRICS.filter((m) => has(epochs, m.key))
    .map((m) => ({ data: series(epochs, m.key, total), color: m.color, label: m.label, area: m.area }));
  return (
    <Card title="Метрики по эпохам" desc="Считаются на val после каждой эпохи">
      <LineChart series={lines} total={total} label="Метрики по эпохам" />
      <Legend items={lines.map((l) => ({ label: l.label, color: l.color, kind: "line" }))} />
    </Card>
  );
}

const LOSSES = [
  { key: "box_loss", label: "рамка", color: "var(--c1)" },
  { key: "cls_loss", label: "класс", color: "var(--c5)" },
  { key: "dfl_loss", label: "форма", color: "var(--c3)" },
  { key: "seg_loss", label: "маска", color: "var(--c2)" },
];

/** Шкала потерь: верх — круглое число над максимумом. */
export function lossScale(max: number): number[] {
  const top = max <= 0 ? 1 : max <= 1 ? Math.ceil(max * 4) / 4 : max <= 4 ? Math.ceil(max * 2) / 2 : Math.ceil(max);
  return [0, top / 4, top / 2, (top * 3) / 4, top];
}

export function LossCard({ epochs, total }: { epochs: EpochRow[]; total: number }) {
  const used = LOSSES.filter((l) => has(epochs, l.key) || has(epochs, `val/${l.key}`));
  const lines: LineSeries[] = used.flatMap((l) => [
    { data: series(epochs, l.key, total), color: l.color, label: l.label },
    { data: series(epochs, `val/${l.key}`, total), color: l.color, label: `${l.label} — val`, dash: true },
  ]);
  const max = Math.max(0, ...lines.flatMap((l) => l.data.filter((v): v is number => v != null)));
  const ticks = lossScale(max);
  return (
    <Card title="Потери" desc="Сплошная — train, пунктир — val. Разошлись — модель запоминает, а не учится">
      <LineChart series={lines} total={total} yMax={ticks[4]} ticks={ticks} label="Потери по эпохам"
        format={(v) => v.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} />
      <Legend items={[...used.map((l) => ({ label: l.label, color: l.color, kind: "line" as const })),
        { label: "val", color: "var(--muted-fg)", kind: "dash" }]} />
    </Card>
  );
}

const BG = "фон";

function Mark({ name, colorOf }: { name: string; colorOf: ColorOf }) {
  return name === BG ? <Swatch title="Фон" /> : <Swatch color={colorOf(name) ?? "var(--faint)"} />;
}
const pairName = (v: ConfusionView, i: number, j: number) =>
  `${v.names[i] === BG ? "Фон" : v.names[i]} → ${v.names[j] === BG ? "не найден" : v.names[j]}`;

function Grid({ v, colorOf }: { v: ConfusionView; colorOf: ColorOf }) {
  const last = v.names.length - 1;
  return (
    <div className="rn-cm" style={{ "--n": v.names.length } as CSSProperties} role="table" aria-label="Матрица ошибок">
      <span />
      {v.names.map((n, j) => <span key={j} className="rn-cm-h" title={`Предсказано: ${n}`}><Mark name={n} colorOf={colorOf} /></span>)}
      {v.shares.map((row, i) => [
        <span key={`l${i}`} className="rn-cm-l" title={`Истинный класс: ${v.names[i]}`}>
          <Mark name={v.names[i]} colorOf={colorOf} /><span className="t-ell">{v.names[i] === BG ? "Фон" : v.names[i]}</span>
        </span>,
        ...row.map((p, j) => {
          if (i === last && j === last) return <span key={j} className="rn-cm-c na" title="Фон как фон не считается">—</span>;
          const diag = i === j;
          const val = Math.round(p * 100);
          const bg = diag ? `color-mix(in srgb, var(--c2) ${Math.round(12 + p * 68)}%, var(--card))`
            : p > 0 ? `color-mix(in srgb, var(--st-del) ${Math.min(80, Math.round(10 + p * 280))}%, var(--card))` : undefined;
          return (
            <span key={j} className={cx("rn-cm-c", p === 0 && "z", (diag || p >= 0.05) && "hi")} style={bg ? { background: bg } : undefined}
              title={`${pairName(v, i, j)}: ${pct(p)} · ${v.counts[i][j].toLocaleString("ru-RU")}`}>
              {p > 0 && val < 1 ? "<1" : val}
            </span>
          );
        }),
      ])}
    </div>
  );
}

function Pairs({ v, colorOf, limit }: { v: ConfusionView; colorOf: ColorOf; limit: number }) {
  const top = topConfusions(v, limit);
  if (!top.length) return <p className="t-sm t-muted">Путаниц от 2 % нет.</p>;
  const mx = top[0].share;
  return (
    <ul className="rn-pairs">
      {top.map((t) => (
        <li key={`${t.truth}-${t.pred}`}>
          <span className="row" style={{ gap: 6, minWidth: 0 }}>
            <Mark name={v.names[t.truth]} colorOf={colorOf} />
            <span className="t-ell">{v.names[t.truth] === BG ? "Фон" : v.names[t.truth]}</span>
            <span className="t-faint">→</span>
            <Mark name={v.names[t.pred]} colorOf={colorOf} />
            <span className="t-ell">{v.names[t.pred] === BG ? "не найден" : v.names[t.pred]}</span>
          </span>
          <span className="mono t-xs">{pct(t.share)}</span>
          <div className="rn-pair-bar"><i style={{ width: `${(t.share / mx) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

const scale = (c: string, to: string) => (
  <span className="rn-scale">
    <i style={{ background: `linear-gradient(90deg, color-mix(in srgb, ${c} 12%, var(--card)), color-mix(in srgb, ${c} 80%, var(--card)))` }} />
    <span className="mono">0</span><span className="mono" style={{ textAlign: "right" }}>{to}</span>
  </span>
);

export function ConfusionCard({ data, colorOf, done }: {
  data: { matrix: number[][]; names: string[] } | null | undefined; colorOf: ColorOf; done: boolean;
}) {
  const [view, setView] = useState<"grid" | "list">("grid");
  const v = useMemo(() => (data ? confusionView(data) : null), [data]);
  const seg = <Seg size="sm" label="Вид матрицы" value={view} onChange={setView}
    options={[{ value: "grid", label: "Сетка" }, { value: "list", label: "Путаницы" }]} />;
  if (!v) {
    return (
      <Card title="Матрица ошибок">
        <p className="t-sm t-muted">{done ? "Не посчиталась. Обучение это не портит — веса на месте."
          : "Появится после итоговой проверки, когда обучение закончится."}</p>
      </Card>
    );
  }
  return (
    <Card title="Матрица ошибок" actions={seg}
      desc={view === "grid" ? "Доля от всех объектов класса в строке. Наведите на ячейку, чтобы увидеть пару"
        : "Пары классов, которые модель путает чаще всего"}>
      {view === "list" ? <Pairs v={v} colorOf={colorOf} limit={10} /> : (
        <div className="rn-cm-wrap">
          <div className="stack-v" style={{ gap: 12 }}>
            <div className="ui-table-w"><Grid v={v} colorOf={colorOf} /></div>
            <div className="row wrap t-xs t-muted" style={{ gap: "10px 22px", alignItems: "flex-start" }}>
              <span className="stack-v" style={{ gap: 4 }}>Верные, % строки{scale("var(--c2)", "100")}</span>
              <span className="stack-v" style={{ gap: 4 }}>Путаница, % строки{scale("var(--st-del)", "25+")}</span>
              <span className="stack-v" style={{ gap: 4 }}>Не путались<span className="rn-cm-c z" style={{ width: 24 }}>0</span></span>
            </div>
          </div>
          <div className="stack-v rn-cm-side">
            <span className="rn-sub">Чаще всего путает</span>
            <Pairs v={v} colorOf={colorOf} limit={4} />
            <p className="t-xs t-faint">Строка — что было на кадре, столбец — что увидела модель. «Фон» в столбце — объект не нашёлся.
              {v.hidden > 0 && ` Скрыто классов без объектов и срабатываний: ${v.hidden}.`}</p>
          </div>
        </div>
      )}
    </Card>
  );
}

const COLUMNS: { key: keyof ClassMetric; label: string; hint: string }[] = [
  { key: "instances", label: "Объектов", hint: "сколько их в проверочной части" },
  { key: "precision", label: "Точность", hint: "из найденного — сколько верно" },
  { key: "recall", label: "Полнота", hint: "из бывшего — сколько нашла" },
  { key: "f1", label: "F1", hint: "точность и полнота одним числом" },
  { key: "map50", label: "mAP50", hint: "при совпадении рамок наполовину" },
  { key: "map", label: "mAP50-95", hint: "строже: среднее по порогам" },
];

function ClassTable({ data, colorOf }: { data: PerClass; colorOf: ColorOf }) {
  const [sort, setSort] = useState<keyof ClassMetric>("map50");
  const [asc, setAsc] = useState(true);
  const rows = [...data.rows].sort((a, b) => {
    if (a.measured !== b.measured) return a.measured ? -1 : 1;
    const x = typeof a[sort] === "number" ? (a[sort] as number) : -1;
    const y = typeof b[sort] === "number" ? (b[sort] as number) : -1;
    return asc ? x - y : y - x;
  });
  const cell = (v: number | null, key: string) =>
    v == null ? <span className="t-faint">—</span> : key === "instances" ? v.toLocaleString("ru-RU") : dec(v);
  return (
    <Table className="rn-cls">
      <thead>
        <tr>
          <th>Класс</th>
          {COLUMNS.map((c) => (
            <th key={c.key} className="r" title={c.hint} aria-sort={sort === c.key ? (asc ? "ascending" : "descending") : undefined}>
              <button type="button" className="rn-sort" onClick={() => {
                if (sort === c.key) setAsc((v) => !v); else { setSort(c.key); setAsc(true); }
              }}>{c.label}{sort === c.key ? (asc ? " ↑" : " ↓") : ""}</button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.class_index} className={r.measured ? undefined : "rn-unmeasured"}>
            <td><span className="row"><Swatch color={colorOf(r.name) ?? "var(--faint)"} /><span className="t-ell">{r.name}</span></span></td>
            {COLUMNS.map((c) => <td key={c.key} className="r mono">{cell(r[c.key] as number | null, String(c.key))}</td>)}
          </tr>
        ))}
        {data.totals && (
          <tr className="rn-totals">
            <td>Среднее по измеренным</td>
            <td className="r mono">{data.totals.instances.toLocaleString("ru-RU")}</td>
            {(["precision", "recall", "f1", "map50", "map"] as const).map((k) => (
              <td key={k} className="r mono">{cell(data.totals![k], k)}</td>
            ))}
          </tr>
        )}
      </tbody>
    </Table>
  );
}

export function ClassesCard({ data, colorOf }: { data: PerClass | null | undefined; colorOf: ColorOf }) {
  const [view, setView] = useState<"bars" | "table">("bars");
  if (!data) return null;
  if (data.error) return <Card title="AP50 по классам"><Notice tone="warn">{data.error}</Notice></Card>;
  if (!data.rows?.length) return null;
  const measured = data.rows.filter((r) => r.measured && r.map50 != null).sort((a, b) => (b.map50 ?? 0) - (a.map50 ?? 0));
  const unmeasured = data.rows.length - measured.length;
  const worst = (data.worst ?? []).map((i) => data.rows.find((r) => r.class_index === i)).filter((r): r is ClassMetric => !!r);
  return (
    <Card title="AP50 по классам" desc={view === "bars" ? "Жёлтым — ниже 0,5" : "Щелчок по столбцу — сортировка"}
      actions={<Seg size="sm" label="Вид" value={view} onChange={setView}
        options={[{ value: "bars", label: "Полосы" }, { value: "table", label: "Таблица" }]} />}>
      {view === "bars" ? (
        <div className="bal">
          {measured.map((r) => (
            <div key={r.class_index} className="bal-r rn-ap">
              <span className="bal-n"><Swatch color={colorOf(r.name) ?? "var(--faint)"} /><span className="t-ell">{r.name}</span></span>
              <div className="bal-t" title={`${r.name}: AP50 ${dec(r.map50 ?? 0, 2)}, объектов ${r.instances}`}>
                <i style={{ width: `${(r.map50 ?? 0) * 100}%`, flex: "none", background: (r.map50 ?? 0) < 0.5 ? "var(--st-skip)" : "var(--c1)" }} />
              </div>
              <span className="bal-v mono">{dec(r.map50 ?? 0, 2)}</span>
            </div>
          ))}
        </div>
      ) : <ClassTable data={data} colorOf={colorOf} />}
      {worst.length > 0 && (
        <p className="t-sm rn-note">Хуже всего выучены: <b>{worst.map((r) => r.name).join(", ")}</b> — их доразметить,
          добавить кадров или проверить по матрице, не путает ли модель их с соседями.</p>
      )}
      {unmeasured > 0 && (
        <p className="t-xs t-faint rn-note">У {count(unmeasured, "класса", "классов", "классов")} в проверочной части нет
          объектов — «измерить нечем», а не «плохо выучен».</p>
      )}
    </Card>
  );
}

/** Кривая по порогу: средняя по классам толстая, классы — тонкие и бледные. */
function Curve({ c }: { c: CurveSeries }) {
  const W = 1100, H = 240, pl = 36, pr = 12, pt = 10, pb = 26;
  const xs = c.x;
  const x0 = xs[0] ?? 0, x1 = xs[xs.length - 1] ?? 1;
  const X = (i: number) => pl + ((xs[i] - x0) / Math.max(1e-6, x1 - x0)) * (W - pl - pr);
  const Y = (v: number) => pt + (H - pt - pb) * (1 - Math.max(0, Math.min(1, v)));
  const mean = xs.map((_, i) => c.y.reduce((a, row) => a + (row[i] ?? 0), 0) / Math.max(1, c.y.length));
  return (
    <svg className="ui-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${c.y_label} от ${c.x_label}`}>
      {[0, 0.25, 0.5, 0.75, 1].map((v) => (
        <g key={v}>
          <line x1={pl} x2={W - pr} y1={Y(v)} y2={Y(v)} className="ui-chart-grid" />
          <text className="ui-chart-ax" x={pl - 6} y={Y(v) + 3} textAnchor="end">{dec(v, 2)}</text>
        </g>
      ))}
      <text className="ui-chart-ax" x={pl} y={H - 8} textAnchor="start">{dec(x0, 1)}</text>
      <text className="ui-chart-ax" x={(pl + W - pr) / 2} y={H - 8} textAnchor="middle">
        {c.x_label === "Confidence" ? "порог уверенности" : c.x_label === "Recall" ? "полнота" : c.x_label}
      </text>
      <text className="ui-chart-ax" x={W - pr} y={H - 8} textAnchor="end">{dec(x1, 1)}</text>
      {c.y.map((row, i) => (
        <path key={i} d={linePath(row, X, Y)} fill="none" style={{ stroke: "var(--muted-fg)" }} strokeWidth={1} opacity={0.25} />
      ))}
      <path d={linePath(mean, X, Y)} fill="none" style={{ stroke: "var(--c1)" }} strokeWidth={2.2} strokeLinejoin="round" />
    </svg>
  );
}

export function CurvesCard({ curves }: { curves: CurveSeries[] | null | undefined }) {
  const [at, setAt] = useState<number | null>(null);
  if (!curves?.length) return null;
  // F1 первой: по ней выбирают порог
  const order = curves.map((c, i) => ({ c, i, label: curveLabel(c, i, curves.length) }))
    .sort((a, b) => (a.label.startsWith("F1") ? -1 : 0) - (b.label.startsWith("F1") ? -1 : 0));
  const cur = order.find((o) => o.i === at) ?? order[0];  // по умолчанию — F1
  return (
    <Card title="Порог уверенности" desc="Где ставить порог: толстая линия — среднее по классам, тонкие — классы"
      actions={<Seg size="sm" label="Кривая" value={String(cur.i)} onChange={(v) => setAt(Number(v))}
        options={order.map((o) => ({ value: String(o.i), label: o.label }))} />}>
      <Curve c={cur.c} />
    </Card>
  );
}
