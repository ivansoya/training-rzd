// Графики обучения: кривые по эпохам и матрица ошибок.
//
// Свои, а не картинки от ultralytics. Картинку нельзя навести, нельзя положить
// два обучения на одну ось и нельзя показать в тёмной палитре сайта — а
// сравнение двух ранов и есть то, ради чего раздел затевался.

import { useId, useState } from "react";
import type { ClassMetric, CurveSeries, EpochRow, PerClass } from "../../api/runs";

const AREA = { x0: 44, y0: 16, x1: 596, y1: 196 };

function scaleY(v: number) {
  return AREA.y1 - Math.max(0, Math.min(1, v)) * (AREA.y1 - AREA.y0);
}

function scaleX(epoch: number, total: number) {
  const span = Math.max(1, total);
  return AREA.x0 + ((epoch - 1) / span) * (AREA.x1 - AREA.x0);
}

// Показываем всё, что меряется по эпохам, а не одну mAP. «Модель стала лучше»
// — это четыре разных вопроса: находит ли (полнота), не выдумывает ли
// (точность), насколько точно обводит (mAP50-95) и что с этим в среднем
// (mAP50). По одной кривой на них не ответить.
const LINES = [
  { key: "metrics/mAP50(B)", label: "mAP50", colour: "#2ee07a" },
  { key: "metrics/mAP50-95(B)", label: "mAP50-95", colour: "#6aa8ff" },
  { key: "metrics/precision(B)", label: "точность", colour: "#ffb02e" },
  { key: "metrics/recall(B)", label: "полнота", colour: "#c78cff" },
  { key: "metrics/mAP50(M)", label: "mAP50 маски", colour: "#31d0d8" },
  { key: "metrics/mAP50-95(M)", label: "mAP50-95 маски", colour: "#ff7ab8" },
];

// Потери живут не в диапазоне 0..1, поэтому у них своя ось и свой график.
// Смотрят на них ради одного: разъехались ли обучение и проверка. Разъехались
// — модель запоминает, а не учится, и дальше учить незачем.
const LOSSES = [
  { key: "box_loss", label: "рамка", colour: "#2ee07a" },
  { key: "cls_loss", label: "класс", colour: "#6aa8ff" },
  { key: "dfl_loss", label: "форма", colour: "#ffb02e" },
  { key: "val/box_loss", label: "рамка · проверка", colour: "#2ee07a", dash: true },
  { key: "val/cls_loss", label: "класс · проверка", colour: "#6aa8ff", dash: true },
  { key: "val/dfl_loss", label: "форма · проверка", colour: "#ffb02e", dash: true },
];

function pick(row: EpochRow, key: string): number | null {
  const value = row.metrics?.[key];
  return typeof value === "number" ? value : null;
}

/** Последнее непустое значение метрики. */
function lastOf(epochs: EpochRow[], key: string): number | null {
  for (let i = epochs.length - 1; i >= 0; i--) {
    const v = pick(epochs[i], key);
    if (v !== null) return v;
  }
  return null;
}

export function MetricChart({
  epochs,
  total,
}: {
  epochs: EpochRow[];
  total: number;
}) {
  const id = useId();
  const present = LINES.filter((l) => epochs.some((e) => pick(e, l.key) !== null));
  const last = epochs[epochs.length - 1];
  const nowX = last ? scaleX(last.epoch, total) : AREA.x0;

  return (
    <div className="t-card">
      <div className="t-card-head">
        <span className="g-label">Качество по эпохам</span>
        <div className="leg">
          {present.map((l) => (
            <span key={l.key}>
              <u style={{ background: l.colour }} />
              {l.label}{" "}
              <b>
                {(() => {
                  const v = lastOf(epochs, l.key);
                  return v === null ? "—" : v.toFixed(3).replace(".", ",");
                })()}
              </b>
            </span>
          ))}
        </div>
      </div>
      <svg
        viewBox="0 0 620 226"
        role="img"
        aria-label={`Качество по эпохам: пройдено ${last?.epoch ?? 0} из ${total}`}
      >
        <g stroke="var(--hair)" strokeWidth="1">
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <line
              key={v}
              x1={AREA.x0}
              y1={scaleY(v)}
              x2={AREA.x1}
              y2={scaleY(v)}
            />
          ))}
        </g>
        <g
          fill="var(--faint)"
          textAnchor="end"
          style={{
            font: "400 10.5px var(--mono)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <text key={v} x={AREA.x0 - 8} y={scaleY(v) + 4}>
              {v.toFixed(2).replace(".", ",")}
            </text>
          ))}
        </g>
        <g
          fill="var(--faint)"
          textAnchor="middle"
          style={{ font: "400 10.5px var(--mono)" }}
        >
          <text x={AREA.x0} y={AREA.y1 + 20}>
            0
          </text>
          <text x={(AREA.x0 + AREA.x1) / 2} y={AREA.y1 + 20}>
            {Math.round(total / 2)}
          </text>
          <text x={AREA.x1} y={AREA.y1 + 20}>
            {total} эпох
          </text>
        </g>

        {/* Докуда дошли: пустая часть графика честно говорит, что рано судить. */}
        {last && last.epoch < total && (
          <>
            <line
              x1={nowX}
              y1={AREA.y0}
              x2={nowX}
              y2={AREA.y1}
              stroke="var(--rule)"
              strokeDasharray="2 4"
            />
            <text
              x={nowX + 6}
              y={AREA.y0 + 12}
              fill="var(--faint)"
              style={{ font: "400 10.5px var(--mono)" }}
            >
              сейчас
            </text>
          </>
        )}

        {present.map((line) => {
          const points = epochs
            .map((e) => {
              const v = pick(e, line.key);
              return v === null ? null : `${scaleX(e.epoch, total)},${scaleY(v)}`;
            })
            .filter(Boolean)
            .join(" ");
          if (!points) return null;
          const [lastX, lastY] = points.split(" ").slice(-1)[0].split(",");
          return (
            <g key={`${id}-${line.key}`}>
              <polyline
                points={points}
                fill="none"
                stroke={line.colour}
                strokeWidth="2"
                strokeLinejoin="round"
              />
              <circle cx={lastX} cy={lastY} r="3.5" fill={line.colour} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Потери по эпохам: обучение сплошной линией, проверка пунктиром. */
export function LossChart({
  epochs,
  total,
}: {
  epochs: EpochRow[];
  total: number;
}) {
  const id = useId();
  const present = LOSSES.filter((l) => epochs.some((e) => pick(e, l.key) !== null));
  if (!present.length) return null;


  const values = epochs.flatMap((e) =>
    present.map((l) => pick(e, l.key)).filter((v): v is number => v !== null)
  );
  const top = Math.max(0.001, ...values);
  const y = (v: number) => AREA.y1 - (v / top) * (AREA.y1 - AREA.y0);

  return (
    <div className="t-card">
      <div className="t-card-head">
        <span className="g-label">Потери по эпохам</span>
        <div className="leg">
          {present.map((l) => (
            <span key={l.key}>
              <u style={{ background: l.colour, opacity: l.dash ? 0.5 : 1 }} />
              {l.label}{" "}
              <b>
                {(() => {
                  const v = lastOf(epochs, l.key);
                  return v === null ? "—" : v.toFixed(3).replace(".", ",");
                })()}
              </b>
            </span>
          ))}
        </div>
      </div>
      <svg viewBox="0 0 620 226" role="img" aria-label="Потери по эпохам">
        <g stroke="var(--hair)" strokeWidth="1">
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <line key={v} x1={AREA.x0} y1={y(top * v)} x2={AREA.x1} y2={y(top * v)} />
          ))}
        </g>
        <g
          fill="var(--faint)"
          textAnchor="end"
          style={{ font: "400 10.5px var(--mono)", fontVariantNumeric: "tabular-nums" }}
        >
          {[0, 0.5, 1].map((v) => (
            <text key={v} x={AREA.x0 - 8} y={y(top * v) + 4}>
              {(top * v).toFixed(2).replace(".", ",")}
            </text>
          ))}
        </g>
        {present.map((line) => {
          const points = epochs
            .map((e) => {
              const v = pick(e, line.key);
              return v === null ? null : `${scaleX(e.epoch, total)},${y(v)}`;
            })
            .filter(Boolean)
            .join(" ");
          if (!points) return null;
          return (
            <polyline
              key={`${id}-${line.key}`}
              points={points}
              fill="none"
              stroke={line.colour}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeDasharray={line.dash ? "4 3" : undefined}
              opacity={line.dash ? 0.75 : 1}
            />
          );
        })}
      </svg>
    </div>
  );
}

const COLUMNS: { key: keyof ClassMetric; label: string; hint: string }[] = [
  { key: "instances", label: "объектов", hint: "сколько их в проверочной части" },
  { key: "precision", label: "точность", hint: "из найденного — сколько верно" },
  { key: "recall", label: "полнота", hint: "из бывшего — сколько нашла" },
  { key: "f1", label: "F1", hint: "точность и полнота одним числом" },
  { key: "map50", label: "mAP50", hint: "при совпадении рамок наполовину" },
  { key: "map", label: "mAP50-95", hint: "строже: среднее по порогам" },
];

/** Метрики по классам: что выучено, а что нет. */
export function ClassMetrics({ data }: { data: PerClass }) {
  const [sort, setSort] = useState<keyof ClassMetric>("map50");
  const [asc, setAsc] = useState(true);

  if (data.error) {
    return (
      <div className="t-card">
        <span className="g-label">Метрики по классам</span>
        <p style={{ color: "var(--skip)", fontSize: 12.5, marginTop: 8 }}>{data.error}</p>
      </div>
    );
  }
  if (!data.rows?.length) return null;

  const rows = [...data.rows].sort((a, b) => {
    // Неизмеренные всегда внизу: сортировать «нечем» бессмысленно.
    if (a.measured !== b.measured) return a.measured ? -1 : 1;
    const x = a[sort];
    const y = b[sort];
    const nx = typeof x === "number" ? x : -1;
    const ny = typeof y === "number" ? y : -1;
    return asc ? nx - ny : ny - nx;
  });
  const unmeasured = data.rows.filter((r) => !r.measured).length;
  const worstNames = (data.worst ?? [])
    .map((i) => data.rows.find((r) => r.class_index === i))
    .filter((r): r is ClassMetric => Boolean(r))
    .map((r) => `${r.name} (${(r.map50 ?? 0).toFixed(2).replace(".", ",")})`);

  const cell = (v: number | null, key: string) => {
    if (v === null) return <span className="t-dash">—</span>;
    if (key === "instances") return v.toLocaleString("ru-RU");
    return (
      <span className="t-num">
        <i style={{ width: `${Math.round(v * 100)}%` }} />
        {v.toFixed(3).replace(".", ",")}
      </span>
    );
  };

  return (
    <div className="t-card">
      <div className="t-card-head">
        <span className="g-label">Метрики по классам</span>
        {data.totals && (
          <span style={{ marginLeft: "auto", color: "var(--faint)", fontSize: 11.5 }}>
            измерено {data.totals.measured} из {data.totals.classes} ·{" "}
            {data.totals.instances.toLocaleString("ru-RU")} объектов
          </span>
        )}
      </div>
      <div className="t-scroll">
        <table className="mag-table t-cls-table">
          <thead>
            <tr>
              <th>Класс</th>
              {COLUMNS.map((c) => (
                <th key={c.key} className="num" title={c.hint}>
                  <button
                    type="button"
                    className={sort === c.key ? "on" : ""}
                    onClick={() => {
                      if (sort === c.key) setAsc((v) => !v);
                      else {
                        setSort(c.key);
                        setAsc(true);
                      }
                    }}
                  >
                    {c.label}
                    {sort === c.key ? (asc ? " ↑" : " ↓") : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.class_index} className={r.measured ? undefined : "t-unmeasured"}>
                <td>
                  <span className="mag-code">{r.class_index}</span> {r.name}
                </td>
                {COLUMNS.map((c) => (
                  <td key={c.key} className="num">
                    {cell(r[c.key] as number | null, String(c.key))}
                  </td>
                ))}
              </tr>
            ))}
            {data.totals && (
              <tr className="t-totals">
                <td>среднее по измеренным</td>
                <td className="num">{data.totals.instances.toLocaleString("ru-RU")}</td>
                <td className="num">{cell(data.totals.precision, "precision")}</td>
                <td className="num">{cell(data.totals.recall, "recall")}</td>
                <td className="num">{cell(data.totals.f1, "f1")}</td>
                <td className="num">{cell(data.totals.map50, "map50")}</td>
                <td className="num">{cell(data.totals.map, "map")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {worstNames.length > 0 && (
        <p style={{ fontSize: 12.5, marginTop: 10 }}>
          Хуже всего выучены: <b>{worstNames.join(", ")}</b>. С них и стоит
          начинать — доразметить, добавить кадров или проверить по матрице
          ниже, не путает ли их модель с соседями.
        </p>
      )}
      {unmeasured > 0 && (
        <p style={{ color: "var(--faint)", fontSize: 11.5, marginTop: 8 }}>
          У {unmeasured} {unmeasured === 1 ? "класса" : "классов"} в проверочной
          части нет ни одного объекта — прочерк здесь значит «измерить нечем», а
          не «плохо выучен».
        </p>
      )}
    </div>
  );
}

/** Кривые PR и F1: как меняется качество с порогом уверенности.
 *
 * Средняя линия толстая, классы — тонкими и бледными. Смотрят сюда ради
 * одного вопроса: где ставить порог. По одному числу mAP на него не ответить,
 * а по кривой видно, что до 0,3 модель ещё ничего не теряет, а после 0,6
 * начинает молчать.
 */
export function CurveChart({ curves }: { curves: CurveSeries[] }) {
  const [shown, setShown] = useState(0);
  const curve = curves[shown];
  if (!curve) return null;

  const box = { x0: 44, y0: 16, x1: 596, y1: 196 };
  const xs = curve.x;
  const spanX = Math.max(1e-6, xs[xs.length - 1] - xs[0]);
  const px = (v: number) => box.x0 + ((v - xs[0]) / spanX) * (box.x1 - box.x0);
  const py = (v: number) => box.y1 - Math.max(0, Math.min(1, v)) * (box.y1 - box.y0);
  const path = (row: number[]) =>
    row.map((v, i) => `${px(xs[i])},${py(v)}`).join(" ");

  // Средняя по классам: у ultralytics отдельной линии нет, а нужна она первой.
  const mean = xs.map((_, i) =>
    curve.y.reduce((a, row) => a + (row[i] ?? 0), 0) / Math.max(1, curve.y.length)
  );

  return (
    <div className="t-card">
      <div className="t-card-head">
        <span className="g-label">Кривые качества</span>
        <span className="mag-switch" style={{ marginLeft: "auto" }}>
          {curves.map((c, i) => (
            <button
              key={c.y_label + c.x_label}
              type="button"
              className={i === shown ? "on" : ""}
              onClick={() => setShown(i)}
            >
              {c.y_label} / {c.x_label}
            </button>
          ))}
        </span>
      </div>
      <svg viewBox="0 0 620 226" role="img" aria-label={`${curve.y_label} от ${curve.x_label}`}>
        <g stroke="var(--hair)" strokeWidth="1">
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <line key={v} x1={box.x0} y1={py(v)} x2={box.x1} y2={py(v)} />
          ))}
        </g>
        <g
          fill="var(--faint)"
          textAnchor="end"
          style={{ font: "400 10.5px var(--mono)", fontVariantNumeric: "tabular-nums" }}
        >
          {[0, 0.5, 1].map((v) => (
            <text key={v} x={box.x0 - 8} y={py(v) + 4}>
              {v.toFixed(1).replace(".", ",")}
            </text>
          ))}
        </g>
        <g fill="var(--faint)" textAnchor="middle" style={{ font: "400 10.5px var(--mono)" }}>
          <text x={box.x0} y={box.y1 + 20}>{xs[0].toFixed(1).replace(".", ",")}</text>
          <text x={(box.x0 + box.x1) / 2} y={box.y1 + 20}>{curve.x_label}</text>
          <text x={box.x1} y={box.y1 + 20}>
            {xs[xs.length - 1].toFixed(1).replace(".", ",")}
          </text>
        </g>
        {curve.y.map((row, i) => (
          <polyline
            key={i}
            points={path(row)}
            fill="none"
            stroke="var(--dim)"
            strokeWidth="1"
            opacity="0.22"
          />
        ))}
        <polyline
          points={path(mean)}
          fill="none"
          stroke="#2ee07a"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
      </svg>
      <p style={{ color: "var(--faint)", fontSize: 11.5, marginTop: 6 }}>
        Толстая линия — среднее по классам, тонкие — классы по отдельности.
      </p>
    </div>
  );
}

export function ConfusionMatrix({
  data,
}: {
  data: { matrix: number[][]; names: string[] };
}) {
  // Подписи приходят готовыми, вместе с «фоном»: считать их здесь заново
  // значило бы держать два мнения о том, есть ли в матрице строка фона.
  const names = data.names;
  const size = Math.min(names.length, data.matrix.length);
  // Клетка ужимается под число классов: на двадцати шести по 54 пикселя
  // матрица уезжает на полтора экрана, и разглядеть в ней ничего нельзя.
  const cell = size > 18 ? 26 : size > 10 ? 36 : 54;
  const font = cell < 30 ? 8.5 : 10.5;
  const left = size > 18 ? 132 : 96;
  const top = 16;

  // Нормируем по столбцу: столбец — это «что было на самом деле», и доля от
  // него отвечает на вопрос «сколько таких модель нашла».
  const columnTotals = Array.from({ length: size }, (_, c) =>
    data.matrix.reduce((a, row) => a + (row[c] ?? 0), 0)
  );

  return (
    <div className="t-card">
      <div className="t-card-head">
        <span className="g-label">Матрица ошибок</span>
        <span style={{ marginLeft: "auto", color: "var(--faint)", fontSize: 11.5 }}>
          строка — что модель сказала, столбец — что было на самом деле
        </span>
      </div>
      <div className="t-scroll">
        <svg
          width={left + size * cell + 12}
          height={top + size * cell + (size > 10 ? 96 : 42)}
          role="img"
          aria-label="Матрица ошибок по классам"
        >
          <g
            fill="var(--faint)"
            textAnchor="end"
            style={{ font: "400 10.5px var(--mono)" }}
          >
            {names.slice(0, size).map((name, r) => (
              <text
                key={name}
                x={left - 10}
                y={top + r * cell + cell / 2 + font / 3}
                style={{ font: `400 ${font}px var(--mono)` }}
              >
                {name.length > 16 ? `${name.slice(0, 15)}…` : name}
              </text>
            ))}
          </g>
          <g
            fill="var(--faint)"
            textAnchor="middle"
            style={{ font: "400 10.5px var(--mono)" }}
          >
            {names.slice(0, size).map((name, c) => (
              <text
                key={name}
                x={left + c * cell + cell / 2}
                y={top + size * cell + 14}
                style={{ font: `400 ${font}px var(--mono)` }}
                // Вертикально: иначе на двадцати шести классах подписи
                // наезжают друг на друга и не читается ни одна.
                transform={
                  size > 10
                    ? `rotate(-60 ${left + c * cell + cell / 2} ${top + size * cell + 14})`
                    : undefined
                }
                textAnchor={size > 10 ? "end" : "middle"}
              >
                {name.length > 14 ? `${name.slice(0, 13)}…` : name}
              </text>
            ))}
          </g>
          {data.matrix.slice(0, size).map((row, r) =>
            row.slice(0, size).map((value, c) => {
              const share = columnTotals[c] ? value / columnTotals[c] : 0;
              const right = r === c;
              const colour = right ? "#2ee07a" : "#ff8a5c";
              return (
                <g key={`${r}-${c}`}>
                  <rect
                    x={left + c * cell}
                    y={top + r * cell}
                    width={cell - 1}
                    height={cell - 1}
                    fill={value > 0 ? colour : "var(--card)"}
                    opacity={value > 0 ? Math.max(0.06, share * 0.9) : 1}
                  />
                  <title>
                    {`модель сказала «${names[r]}», на самом деле «${names[c]}»: `
                      + `${Math.round(value)}`
                      + (columnTotals[c]
                        ? ` (${Math.round(share * 100)} % от «${names[c]}»)`
                        : "")}
                  </title>
                  {value > 0 && (
                    <text
                      x={left + c * cell + cell / 2}
                      y={top + r * cell + cell / 2 + font / 3}
                      textAnchor="middle"
                      fill={share > 0.5 ? "var(--paper)" : "var(--ink)"}
                      style={{
                        font: `400 ${font}px var(--mono)`,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {Math.round(value)}
                    </text>
                  )}
                </g>
              );
            })
          )}
        </svg>
      </div>
    </div>
  );
}
