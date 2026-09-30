// Общая статистика разведки таски: слева ролики, справа «Все ролики» или
// выбранный ролик.
//
// Решения владельца (24.09.2026): кнопка — в шапке таски рядом с «Агент»,
// есть, если разведан хоть один ролик. «Все ролики» — числа, таблица
// «классы × ролики» и под ней по полосе на ролик: где что нашлось. Щелчок по
// полосе или ролику слева — статистика этого ролика, та же, что у его кнопки
// «Разведка».

import { useEffect, useState } from "react";
import * as api from "../../api/agents";
import { plural } from "../mag/ProjectsPage";
import Sep from "../Sep";
import { useBackdrop } from "../useBackdrop";
import FramePeek from "./FramePeek";
import { ScoutBody } from "./ScoutStats";
import { taskColors, useScouts } from "./scout";
import { clock, nearest } from "./scoutMath";

type Loaded = { id: string; stats: api.ScoutStats };

/** Мини-график находок ролика: рамок по долям ролика. */
function Density({ stats }: { stats: api.ScoutStats }) {
  const bins = 60;
  const per = new Array(bins).fill(0);
  stats.checked.forEach((f, i) => {
    per[Math.min(bins - 1, Math.floor((f / Math.max(1, stats.last_frame)) * bins))] += stats.per_frame[i];
  });
  const top = Math.max(1, ...per);
  return (
    <svg className="ag-ov-density" viewBox={`0 0 ${bins} 16`} preserveAspectRatio="none" aria-hidden="true">
      <rect x="0" y="15.5" width={bins} height="0.5" style={{ fill: "var(--hair)" }} />
      {per.map((k, b) => k ? (
        <rect key={b} x={b + 0.1} y={16 - Math.max(1.5, (k / top) * 15)} width="0.8" height={Math.max(1.5, (k / top) * 15)}
          style={{ fill: "var(--agent, #b9a4ff)" }} />
      ) : null)}
    </svg>
  );
}

/** Где что по ролику: на каждом проверенном кадре столбик, сложенный из
 *  классов. Своя шкала у каждого ролика — от начала до конца. */
function Where({ stats, colors }: { stats: api.ScoutStats; colors: Map<string, string> }) {
  const w = Math.max(1, stats.step);
  const top = Math.max(1, stats.max);
  return (
    <svg viewBox={`0 0 ${Math.max(1, stats.last_frame)} 100`} preserveAspectRatio="none" aria-hidden="true">
      {stats.checked.map((f, i) => {
        if (!stats.per_frame[i]) return null;
        let y = 100;
        return stats.classes.map((c) => {
          const k = c.counts[i];
          if (!k) return null;
          const h = (k / top) * 96;
          y -= h;
          return <rect key={`${c.name}:${f}`} x={f} y={y} width={w} height={h} style={{ fill: colors.get(c.name) ?? "var(--dim)" }} />;
        });
      })}
    </svg>
  );
}

function AllVideos({ taskId, loaded, colors, onPick }: {
  taskId: string; loaded: Loaded[]; colors: Map<string, string>; onPick: (id: string) => void;
}) {
  const [hover, setHover] = useState<{ id: string; i: number; x: number; y: number } | null>(null);
  const checked = loaded.reduce((s, v) => s + v.stats.checked.length, 0);
  const hits = loaded.reduce((s, v) => s + v.stats.with_hits, 0);
  const boxes = loaded.reduce((s, v) => s + v.stats.boxes, 0);
  const classes = [...colors.keys()];
  const per = (v: Loaded, name: string) => v.stats.classes.find((c) => c.name === name)?.boxes ?? 0;
  const first = loaded[0]?.stats;
  const hovered = hover ? loaded.find((v) => v.id === hover.id) : undefined;
  return (
    <>
      <div className="ag-stats-h"><h2>Все ролики</h2></div>
      {first && (
        <p className="ag-stats-meta">
          «{first.agent ?? "агент"}»{first.version ? ` v${first.version}` : ""} <Sep /> каждый {first.step}-й кадр
        </p>
      )}
      <div className="ag-stats-figs">
        <div><b>{loaded.length}</b><span>{plural(loaded.length, "ролик", "ролика", "роликов")} разведано</span></div>
        <div><b>{hits.toLocaleString("ru-RU")}<small> из {checked.toLocaleString("ru-RU")}</small></b><span>кадров с находками</span></div>
        <div><b>{boxes.toLocaleString("ru-RU")}</b><span>{plural(boxes, "рамка", "рамки", "рамок")}</span></div>
        <div><b>{classes.length}</b><span>{plural(classes.length, "класс", "класса", "классов")} найдено</span></div>
      </div>
      {classes.length > 0 && (
        <div className="ag-stats-table">
          <table>
            <thead>
              <tr>
                <th>Класс</th>
                {loaded.map((v) => (
                  <th key={v.id} className="n ag-ov-col" title={v.stats.file_name}>
                    <button type="button" onClick={() => onPick(v.id)}>{v.stats.file_name}</button>
                  </th>
                ))}
                <th className="n">Всего</th>
              </tr>
            </thead>
            <tbody>
              {classes.map((name) => (
                <tr key={name}>
                  <td><span className="ag-stats-cls"><i style={{ background: colors.get(name) }} /><span title={name}>{name}</span></span></td>
                  {loaded.map((v) => {
                    const k = per(v, name);
                    return <td key={v.id} className="n">{k ? k.toLocaleString("ru-RU") : <span className="ag-muted">—</span>}</td>;
                  })}
                  <td className="n"><b>{loaded.reduce((s, v) => s + per(v, name), 0).toLocaleString("ru-RU")}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="ag-tl">
        <div className="ag-tl-h"><h4>Где по роликам</h4><span className="ag-tl-hint">у каждого ролика своя шкала; щелчок — открыть ролик</span></div>
        <div className="ag-stats-strips">
          {loaded.map((v) => (
            <div className="ag-stats-row" key={v.id}>
              <span className="ag-stats-cls"><span title={v.stats.file_name}>{v.stats.file_name}</span></span>
              <span className="ag-stats-strip ag-ov-where" role="button" tabIndex={0}
                onClick={() => onPick(v.id)}
                onKeyDown={(e) => { if (e.key === "Enter") onPick(v.id); }}
                onPointerMove={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  const f = ((e.clientX - r.left) / Math.max(1, r.width)) * v.stats.last_frame;
                  setHover({ id: v.id, i: nearest(v.stats.checked, f), x: e.clientX, y: e.clientY });
                }}
                onPointerLeave={() => setHover(null)}>
                <Where stats={v.stats} colors={colors} />
              </span>
              <span className="ag-stats-max">{clock(v.stats.last_frame / (v.stats.fps || 25))}</span>
            </div>
          ))}
        </div>
      </div>
      {hover && hovered && (
        <FramePeek taskId={taskId} videoId={hovered.id} frame={hovered.stats.checked[hover.i]} fps={hovered.stats.fps || 25}
          x={hover.x} y={hover.y}
          rows={hovered.stats.classes.filter((c) => c.counts[hover.i]).map((c) => ({
            name: c.name, color: colors.get(c.name) ?? "var(--dim)", count: c.counts[hover.i],
          }))} />
      )}
    </>
  );
}

export default function ScoutOverview({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const scouts = useScouts(taskId);
  const colors = taskColors(scouts);
  const [loaded, setLoaded] = useState<Loaded[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string>("all");
  const ids = Object.keys(scouts).sort().join(",");

  // Все ролики разом: список слева и сводке нужны числа каждого. Ролик —
  // десятки килобайт даже у часового, запросов столько, сколько роликов.
  useEffect(() => {
    if (!ids) return;
    let alive = true;
    Promise.all(ids.split(",").map((id) => api.scoutStats(taskId, id).then((stats) => ({ id, stats }))))
      .then((all) => alive && setLoaded(all.sort((a, b) => a.stats.file_name.localeCompare(b.stats.file_name, "ru"))))
      .catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [taskId, ids]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const current = loaded?.find((v) => v.id === picked);
  const total = loaded?.reduce((s, v) => s + v.stats.boxes, 0) ?? 0;
  return (
    <div className="mag-backdrop" {...useBackdrop(onClose)}>
      <div className="mag-modal ag-ov" role="dialog" aria-label="Статистика разведки таски">
        <aside className="ag-ov-list">
          <h5>Разведка таски</h5>
          <button type="button" className="ag-ov-item" aria-current={picked === "all"} onClick={() => setPicked("all")}>
            <b>Все ролики</b>
            <span className="ag-ov-meta">
              <span>{loaded?.length ?? "…"} {plural(loaded?.length ?? 0, "ролик", "ролика", "роликов")}</span>
              <span>{total.toLocaleString("ru-RU")} {plural(total, "рамка", "рамки", "рамок")}</span>
            </span>
          </button>
          {loaded?.map((v) => (
            <button key={v.id} type="button" className="ag-ov-item" aria-current={picked === v.id} onClick={() => setPicked(v.id)}>
              <b title={v.stats.file_name}>{v.stats.file_name}</b>
              <Density stats={v.stats} />
              <span className="ag-ov-meta">
                <span>{clock(v.stats.last_frame / (v.stats.fps || 25))}</span>
                <span>{v.stats.boxes.toLocaleString("ru-RU")} {plural(v.stats.boxes, "рамка", "рамки", "рамок")}</span>
              </span>
            </button>
          ))}
        </aside>
        <div className="ag-ov-pane">
          <button className="ag-stats-x ag-ov-x" type="button" aria-label="Закрыть" onClick={onClose}>✕</button>
          {error && <div className="mag-error">{error}</div>}
          {!loaded && !error && <p className="ag-muted">Считаю…</p>}
          {loaded && picked === "all" && (
            <AllVideos taskId={taskId} loaded={loaded} colors={colors} onPick={setPicked} />
          )}
          {current && (
            <>
              <div className="ag-stats-h"><h2 title={current.stats.file_name}>{current.stats.file_name}</h2></div>
              <ScoutBody key={current.id} taskId={taskId} videoId={current.id} stats={current.stats} colors={colors} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
