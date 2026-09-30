// Статистика разведки одного ролика: общие числа, классы и «по времени».
//
// Решения владельца (24.09.2026):
// - кнопка «Разведка» у ролика открывает окно только этого ролика; между
//   роликами переключаются в общей статистике таски (ScoutOverview);
// - шкала приближается: над полосами весь ролик тонкой полосой с рамкой
//   окна, колесо — масштаб у указателя, протяжка — сдвиг, рамку можно
//   тащить; на часовом ролике иначе отметки сливались в штрихи;
// - кадр — в карточке при наведении, ленты кадров нет.
// Числа считает сервер (agent_graph.scout_stats): у часового ролика тысячи
// проверенных кадров, и гнать их в браузер ради десятка чисел незачем.

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import * as api from "../../api/agents";
import { plural } from "../ru";
import Sep from "../Sep";
import { useBackdrop } from "../useBackdrop";
import FramePeek from "./FramePeek";
import { taskColors, useScouts } from "./scout";
import { clampView, clock, nearest, timeTicks } from "./scoutMath";

const comma = (v: number, digits = 2) => v.toFixed(digits).replace(".", ",");

const when = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

type View = { a: number; b: number };
interface Hover { i: number; row: string; x: number; y: number }

/** Уверенность по десятым: столбик на десятую, белая черта — медиана. */
function Hist({ hist, median, color }: { hist: number[]; median: number; color: string }) {
  const top = Math.max(1, ...hist);
  return (
    <svg className="ag-stats-hist" width="64" height="20" viewBox="0 0 64 20" aria-hidden="true">
      <rect x="0" y="18" width="64" height="1" style={{ fill: "var(--rule)" }} />
      {hist.map((v, i) => {
        const h = v ? Math.max(1.5, (v / top) * 18) : 0;
        return <rect key={i} x={i * 6.4 + 0.4} y={18 - h} width="5.6" height={h} style={{ fill: color }} fillOpacity={0.85} />;
      })}
      <rect x={Math.min(62.5, median * 64)} y="0" width="1.5" height="20" style={{ fill: "var(--ink)" }} />
    </svg>
  );
}

/** Рамок на каждом проверенном кадре — столбиками в окне `view` (кадры).
 *  Окно — это viewBox: приближение не пересчитывает столбики, а растягивает
 *  их, и за краями окна их режет сам SVG. */
export function Bars({ stats, counts, max, color, view, hover }: {
  stats: api.ScoutStats; counts: number[]; max: number; color: string; view: View; hover: number | null;
}) {
  const width = Math.max(1, stats.step * 0.72);
  const on = hover === null ? null : stats.checked[hover];
  return (
    <svg viewBox={`${view.a} 0 ${Math.max(1, view.b - view.a)} 100`} preserveAspectRatio="none" aria-hidden="true">
      {on !== null && (
        <rect x={on - stats.step * 0.14} y={0} width={stats.step} height={100} style={{ fill: "var(--ink)" }} fillOpacity={0.12} />
      )}
      {counts.map((k, i) => {
        const f = stats.checked[i];
        if (!k || f < view.a - stats.step || f > view.b) return null;
        const h = Math.max(6, (k / Math.max(1, max)) * 100);
        return (
          <rect key={f} x={f} y={100 - h} width={width} height={h} style={{ fill: color }}
            fillOpacity={on === null ? 0.8 : f === on ? 1 : 0.4} />
        );
      })}
    </svg>
  );
}

/** Шкала «по времени» с приближением и карточкой кадра при наведении. */
function Timeline({ taskId, videoId, stats, colors }: {
  taskId: string; videoId: string; stats: api.ScoutStats; colors: Map<string, string>;
}) {
  const fps = stats.fps || 25;
  const last = Math.max(1, stats.last_frame);
  // Уже восьми проверенных кадров окно не бывает: дальше смотреть нечего.
  const minSpan = stats.step * 8;
  const [view, setView] = useState<View>({ a: 0, b: last });
  const [hover, setHover] = useState<Hover | null>(null);
  const lanes = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; a: number; span: number; width: number; scale: number } | null>(null);
  const span = view.b - view.a;
  const full = view.a <= 0 && view.b >= last;

  useEffect(() => setView({ a: 0, b: last }), [videoId, last]);

  // Колесо — нативно и не пассивно: у React onWheel нет права на
  // preventDefault, и вместо масштаба уезжало бы окно.
  useEffect(() => {
    const el = lanes.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const strip = (e.target as Element).closest(".ag-stats-strip");
      if (!strip) return;
      e.preventDefault();
      const r = strip.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      setView((v) => {
        const s = v.b - v.a;
        const next = s * (e.deltaY > 0 ? 1.25 : 0.8);
        return clampView(v.a + ratio * s - ratio * next, next, last, minSpan);
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [last, minSpan]);

  const rows = [
    { name: "Все классы", color: "var(--dim)", counts: stats.per_frame, max: stats.max },
    ...stats.classes.map((c) => ({ name: c.name, counts: c.counts, max: c.max, color: colors.get(c.name) ?? "var(--dim)" })),
  ];

  function frameAt(el: HTMLElement, clientX: number) {
    const r = el.getBoundingClientRect();
    return view.a + ((clientX - r.left) / Math.max(1, r.width)) * span;
  }

  // Протяжка сдвигает окно: по полосам — в масштабе окна, по обзору — в
  // масштабе всего ролика (`scale` — сколько кадров в ширине полосы).
  function grab(e: ReactPointerEvent<HTMLElement>, a: number, scale: number) {
    if (e.button !== 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    drag.current = { x: e.clientX, a, span, width: r.width, scale };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e: ReactPointerEvent<HTMLElement>, sign: number) {
    const d = drag.current;
    if (!d) return;
    const shift = ((e.clientX - d.x) / Math.max(1, d.width)) * d.scale;
    setView(clampView(d.a + sign * shift, d.span, last, minSpan));
  }
  const drop = () => { drag.current = null; };

  const label = full
    ? `весь ролик, ${clock(last / fps)}`
    : `${clock(view.a / fps)}–${clock(view.b / fps)}, окно ${clock(span / fps)}`;
  const at = hover === null ? null : stats.checked[hover.i];
  const marks = [
    [view.a, clock(view.a / fps), "first"] as const,
    ...timeTicks(view.a, view.b, fps).map((s) => [s * fps, clock(s), ""] as const),
    [view.b, clock(view.b / fps), "last"] as const,
  ];

  return (
    <div className="ag-tl">
      <div className="ag-tl-h">
        <h4>По времени</h4>
        <span className="ag-tl-win">{label}</span>
        <span className="ag-tl-hint">колесо — масштаб, протяжка — сдвиг</span>
        {/* Кнопка стоит всегда, на полном ролике — погашенная: появляясь,
            она сдвигала бы полосы под указателем посреди прокрутки. */}
        <button type="button" className="mag-ghost mag-ghost-inline" disabled={full}
          onClick={() => setView({ a: 0, b: last })}>
          Весь ролик
        </button>
      </div>

      <div className="ag-stats-row ag-tl-over">
        <span className="ag-stats-cls ag-muted">обзор</span>
        {/* Весь ролик с рамкой окна: щелчок мимо рамки ставит туда окно,
            протяжка везёт рамку. */}
        <span className="ag-stats-strip"
          onPointerDown={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const f = ((e.clientX - r.left) / r.width) * last;
            let a = view.a;
            if (f < view.a || f > view.b) {
              a = clampView(f - span / 2, span, last, minSpan).a;
              setView({ a, b: a + span });
            }
            grab(e, a, last);
          }}
          onPointerMove={(e) => move(e, 1)} onPointerUp={drop} onPointerCancel={drop}>
          <Bars stats={stats} counts={stats.per_frame} max={stats.max} color="var(--faint)" view={{ a: 0, b: last }} hover={null} />
          <i className="ag-tl-box" style={{ left: `${(view.a / last) * 100}%`, width: `${Math.max(0.5, (span / last) * 100)}%` }} />
        </span>
        <span />
      </div>

      <div className="ag-stats-strips" ref={lanes}>
        {rows.map((r) => (
          <div className="ag-stats-row" key={r.name}>
            <span className="ag-stats-cls"><i style={{ background: r.color }} /><span title={r.name}>{r.name}</span></span>
            <span className="ag-stats-strip"
              onPointerDown={(e) => grab(e, view.a, span)}
              onPointerMove={(e) => {
                // Протяжка тянет ролик за собой: окно едет навстречу руке.
                move(e, -1);
                const i = nearest(stats.checked, frameAt(e.currentTarget, e.clientX));
                setHover({ i, row: r.name, x: e.clientX, y: e.clientY });
              }}
              onPointerUp={drop}
              onPointerCancel={drop}
              onPointerLeave={() => setHover(null)}>
              <Bars stats={stats} counts={r.counts} max={r.max} color={r.color} view={view} hover={hover?.i ?? null} />
            </span>
            <span className="ag-stats-max">до {r.max}</span>
          </div>
        ))}
        <div className="ag-stats-axis">
          <i />
          <div>
            {marks.map(([f, text, klass], i) => (
              <span key={i} className={klass || undefined} style={{ left: `${((f - view.a) / Math.max(1, span)) * 100}%` }}>{text}</span>
            ))}
          </div>
        </div>
      </div>

      {hover && at !== null && (
        <FramePeek taskId={taskId} videoId={videoId} frame={at} fps={fps} x={hover.x} y={hover.y} focus={hover.row}
          rows={stats.classes.filter((c) => c.counts[hover.i]).map((c) => ({
            name: c.name, color: colors.get(c.name) ?? "var(--dim)", count: c.counts[hover.i],
          }))} />
      )}
    </div>
  );
}

/** Тело статистики ролика — в своём окне и в правой части общей статистики. */
export function ScoutBody({ taskId, videoId, stats, colors }: {
  taskId: string; videoId: string; stats: api.ScoutStats; colors: Map<string, string>;
}) {
  const fps = stats.fps || 25;
  const checked = stats.checked.length;
  const seconds = (name: string) =>
    (stats.segments[name] ?? []).reduce((s, [a, b]) => s + (b - a + 1), 0) / fps;
  return (
    <>
      <p className="ag-stats-meta">
        «{stats.agent ?? "агент"}»{stats.version ? ` v${stats.version}` : ""} <Sep /> {when(stats.created_at)}{" "}
        <Sep /> каждый {stats.step}-й кадр: проверено {checked.toLocaleString("ru-RU")} из {(stats.last_frame + 1).toLocaleString("ru-RU")}
        {" "}<Sep /> {clock(stats.last_frame / fps)}
      </p>
      <div className="ag-stats-figs">
        <div><b>{stats.with_hits.toLocaleString("ru-RU")}<small> из {checked.toLocaleString("ru-RU")}</small></b><span>кадров с находками</span></div>
        <div><b>{stats.boxes.toLocaleString("ru-RU")}</b><span>{plural(stats.boxes, "рамка", "рамки", "рамок")}</span></div>
        <div><b>{comma(stats.boxes / Math.max(1, checked), 1)}</b><span>в среднем на кадр</span></div>
        <div>
          <b>{stats.max}</b>
          <span>
            максимум на кадре
            {stats.max_at !== null && ` — кадр ${stats.max_at}, ${clock(stats.max_at / fps)}`}
          </span>
        </div>
      </div>
      {stats.classes.length === 0 ? (
        <p className="ag-muted">Агент на проверенных кадрах ничего не нашёл.</p>
      ) : (
        <>
          <div className="ag-stats-table">
            <table>
              <thead>
                <tr>
                  <th>Класс</th>
                  <th className="n">Рамок</th>
                  <th className="n">Кадров</th>
                  <th className="n">Одновременно</th>
                  <th>Уверенность: медиана, разброс</th>
                  <th className="n">Размер, px</th>
                  <th>Участки</th>
                </tr>
              </thead>
              <tbody>
                {stats.classes.map((c) => {
                  const spans = stats.segments[c.name]?.length ?? 0;
                  const color = colors.get(c.name) ?? "var(--dim)";
                  return (
                    <tr key={c.name}>
                      <td><span className="ag-stats-cls"><i style={{ background: color }} /><span title={c.name}>{c.name}</span></span></td>
                      <td className="n">{c.boxes.toLocaleString("ru-RU")}</td>
                      <td className="n">{c.frames} <span className="ag-muted">{Math.round((c.frames / Math.max(1, checked)) * 100)}&nbsp;%</span></td>
                      <td className="n">до {c.max}</td>
                      <td>
                        <span className="ag-stats-conf">
                          <b>{comma(c.conf.median)}</b>
                          <Hist hist={c.conf.hist} median={c.conf.median} color={color} />
                          <small>{comma(c.conf.min)}–{comma(c.conf.max)}</small>
                        </span>
                      </td>
                      <td className="n">{c.size[0]}×{c.size[1]}</td>
                      <td>{spans} {plural(spans, "участок", "участка", "участков")}, {Math.round(seconds(c.name))} с</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Timeline taskId={taskId} videoId={videoId} stats={stats} colors={colors} />
        </>
      )}
    </>
  );
}

/** Окно разведки одного ролика — по кнопке «Разведка» у этого ролика. */
export default function ScoutStats({ taskId, videoId, onClose }: {
  taskId: string;
  videoId: string;
  onClose: () => void;
}) {
  const scouts = useScouts(taskId);
  const [stats, setStats] = useState<api.ScoutStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.scoutStats(taskId, videoId)
      .then((s) => alive && setStats(s))
      .catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [taskId, videoId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="mag-backdrop" {...useBackdrop(onClose)}>
      <div className="mag-modal ag-stats" role="dialog" aria-label="Статистика разведки">
        <div className="ag-stats-h">
          <h1>Разведка</h1>
          <span className="ag-stats-video" title={stats?.file_name}>{stats?.file_name}</span>
          <button className="ag-stats-x" type="button" aria-label="Закрыть" onClick={onClose}>✕</button>
        </div>
        {error && <div className="mag-error">{error}</div>}
        {!stats && !error && <p className="ag-muted">Считаю…</p>}
        {stats && <ScoutBody taskId={taskId} videoId={videoId} stats={stats} colors={taskColors(scouts)} />}
      </div>
    </div>
  );
}
