// Окно статистики разведки: общие числа по ролику, классы и «по времени».
//
// Решения владельца (24.09.2026): окно открывают строка сводки под именем
// ролика и «Статистика» в полосе прогона, само оно не выскакивает — прогон
// может кончиться посреди другой работы. Разведано несколько роликов —
// вкладки наверху. Числа считает сервер (agent_graph.scout_stats): у часового
// ролика тысячи проверенных кадров, и гнать их в браузер ради десятка чисел
// незачем.

import { useEffect, useState } from "react";
import * as api from "../../api/agents";
import { plural } from "../mag/ProjectsPage";
import Sep from "../Sep";
import { useBackdrop } from "../useBackdrop";
import { scoutLanes, useScouts } from "./scout";

const comma = (v: number, digits = 2) => v.toFixed(digits).replace(".", ",");
// Шаги шкалы времени, секунды.
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

function clock(sec: number): string {
  const s = Math.floor(sec);
  const tail = `${String(Math.floor(s / 60) % 60).padStart(s >= 3600 ? 2 : 1, "0")}:${String(s % 60).padStart(2, "0")}`;
  return s >= 3600 ? `${Math.floor(s / 3600)}:${tail}` : tail;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

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

/** Проверенный кадр под указателем: ближайший к x на шкале ролика. */
function nearest(checked: number[], frame: number): number {
  let lo = 0;
  let hi = checked.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (checked[mid] < frame) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && frame - checked[lo - 1] < checked[lo] - frame ? lo - 1 : lo;
}

interface Hover { i: number; row: string; x: number; y: number }

/** Рамок на каждом проверенном кадре — столбиками на шкале ролика.
 *
 *  Наведение общее на все полосы: подсвечивается один и тот же кадр во всех
 *  классах, а подсказка перечисляет их разом. Попадать мышью в столбик шириной
 *  в пиксель не нужно — берётся ближайший проверенный кадр. */
function Strip({ stats, counts, max, color, row, hover, onHover }: {
  stats: api.ScoutStats; counts: number[]; max: number; color: string; row: string;
  hover: Hover | null; onHover: (h: Hover | null) => void;
}) {
  const width = Math.max(1, stats.step * 0.72);
  const on = hover ? stats.checked[hover.i] : null;
  return (
    <span
      className="ag-stats-strip"
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const frame = ((e.clientX - r.left) / Math.max(1, r.width)) * stats.last_frame;
        onHover({ i: nearest(stats.checked, frame), row, x: e.clientX, y: e.clientY });
      }}
      onMouseLeave={() => onHover(null)}
    >
      <svg viewBox={`0 0 ${Math.max(1, stats.last_frame)} 100`} preserveAspectRatio="none" aria-hidden="true">
        {on !== null && (
          <rect x={on - stats.step * 0.14} y={0} width={stats.step} height={100} style={{ fill: "var(--ink)" }} fillOpacity={0.12} />
        )}
        {counts.map((k, i) => {
          if (!k) return null;
          const f = stats.checked[i];
          const h = Math.max(6, (k / Math.max(1, max)) * 100);
          return (
            <rect key={f} x={f} y={100 - h} width={width} height={h} style={{ fill: color }}
              fillOpacity={on === null ? 0.8 : f === on ? 1 : 0.4} />
          );
        })}
      </svg>
    </span>
  );
}

/** Подсказка у указателя — в стиле панелей сайта, а не системная. */
function Tip({ stats, hover, rows, fps }: {
  stats: api.ScoutStats; hover: Hover; fps: number;
  rows: { name: string; color: string; counts: number[]; all: boolean }[];
}) {
  const f = stats.checked[hover.i];
  const found = rows.filter((r) => !r.all && r.counts[hover.i]);
  const total = stats.per_frame[hover.i] ?? 0;
  // У правого края окна подсказка встаёт слева от указателя, иначе её режет.
  const left = hover.x + 260 > window.innerWidth ? hover.x - 256 : hover.x + 14;
  return (
    <div className="ag-stats-tip" style={{ left, top: hover.y + 16 }} role="tooltip">
      <div className="ag-stats-tip-h"><b>Кадр {f}</b><span>{clock(f / fps)}</span></div>
      {found.length === 0 ? (
        <p>ничего не найдено</p>
      ) : (
        <>
          {found.map((r) => (
            <div key={r.name} className={r.name === hover.row ? "on" : undefined}>
              <i style={{ background: r.color }} /><span>{r.name}</span><b>{r.counts[hover.i]}</b>
            </div>
          ))}
          {found.length > 1 && (
            <div className="ag-stats-tip-sum"><span>всего</span><b>{total} {plural(total, "рамка", "рамки", "рамок")}</b></div>
          )}
        </>
      )}
    </div>
  );
}

function Body({ stats, colors, showName }: { stats: api.ScoutStats; colors: Map<string, string>; showName: boolean }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const fps = stats.fps || 25;
  const checked = stats.checked.length;
  const seconds = (name: string) =>
    (stats.segments[name] ?? []).reduce((s, [a, b]) => s + (b - a + 1), 0) / fps;
  // Подписи шкалы — круглые отметки (0:15, 0:30…) примерно на четвертях
  // ролика и его конец; четверть от 59 с дала бы «0:44».
  const end = Math.floor(stats.last_frame / fps);
  const every = TICK_STEPS.find((s) => s >= end / 4) ?? 3600;
  const ticks = Array.from({ length: Math.ceil(end / every) }, (_, i) => i * every)
    .map((sec) => [sec * fps, clock(sec)] as const)
    .concat([[stats.last_frame, clock(end)] as const]);
  const rows = [
    { name: "Все классы", color: "var(--dim)", counts: stats.per_frame, max: stats.max, all: true },
    ...stats.classes.map((c) => ({ ...c, color: colors.get(c.name) ?? "var(--dim)", all: false })),
  ];
  return (
    <>
      <p className="ag-stats-meta">
        «{stats.agent ?? "агент"}»{stats.version ? ` v${stats.version}` : ""} <Sep /> {when(stats.created_at)}{" "}
        <Sep /> каждый {stats.step}-й кадр: проверено {checked} из {(stats.last_frame + 1).toLocaleString("ru-RU")}
        {showName && <> <Sep /> {stats.file_name}</>}
      </p>
      <div className="ag-stats-figs">
        <div><b>{stats.with_hits}<small> из {checked}</small></b><span>кадров с находками</span></div>
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
          <div className="ag-stats-time">
            <h4>По времени</h4>
            <span>рамок на каждом проверенном кадре; наведите на столбик — номер кадра и время</span>
          </div>
          <div className="ag-stats-strips">
            {rows.map((r) => (
              <div className="ag-stats-row" key={r.name}>
                <span className="ag-stats-cls"><i style={{ background: r.color }} /><span title={r.name}>{r.name}</span></span>
                <Strip stats={stats} counts={r.counts} max={r.max} color={r.color} row={r.name}
                  hover={hover} onHover={setHover} />
                <span className="ag-stats-max">до {r.max}</span>
              </div>
            ))}
            {/* Шкала — в колонке полос: подписи ставятся по той же ширине. */}
            <div className="ag-stats-axis">
              <i />
              <div>
                {ticks.map(([f, label], i) => (
                  <span key={i} className={i === 0 ? "first" : i === ticks.length - 1 ? "last" : undefined}
                    style={{ left: `${(f / Math.max(1, stats.last_frame)) * 100}%` }}>{label}</span>
                ))}
              </div>
            </div>
          </div>
          {hover && <Tip stats={stats} hover={hover} rows={rows} fps={fps} />}
        </>
      )}
    </>
  );
}

export default function ScoutStats({ taskId, videoId, onClose }: {
  taskId: string;
  videoId: string;
  onClose: () => void;
}) {
  const scouts = useScouts(taskId);
  const [current, setCurrent] = useState(videoId);
  const [stats, setStats] = useState<api.ScoutStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setStats(null);
    setError(null);
    api.scoutStats(taskId, current)
      .then((s) => alive && setStats(s))
      .catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [taskId, current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tabs = Object.entries(scouts)
    .map(([id, s]) => ({ id, name: s.file_name }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  // Цвета — те же, что у полос разведки на шкалах ролика.
  const colors = new Map(scoutLanes(scouts[current]).map((l) => [l.name, l.color]));

  return (
    <div className="mag-backdrop" {...useBackdrop(onClose)}>
      <div className="mag-modal ag-stats" role="dialog" aria-label="Статистика разведки">
        <div className="ag-stats-h">
          <h1>Разведка</h1>
          {tabs.length > 1 && (
            <div className="ag-stats-tabs" role="tablist">
              {tabs.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={t.id === current}
                  title={t.name} onClick={() => setCurrent(t.id)}>
                  {t.name}
                </button>
              ))}
            </div>
          )}
          <button className="ag-stats-x" type="button" aria-label="Закрыть" onClick={onClose}>✕</button>
        </div>
        {error && <div className="mag-error">{error}</div>}
        {!stats && !error && <p className="ag-muted">Считаю…</p>}
        {stats && <Body stats={stats} colors={colors} showName={tabs.length <= 1} />}
      </div>
    </div>
  );
}
