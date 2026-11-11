// Разведка таски: независимая прокрутка роликов и результатов; ответы появляются по мере загрузки.
import { useEffect, useState } from "react";
import * as api from "../../api/agents";
import { Button } from "../../ui";
import { plural } from "../ru";
import Sep from "../Sep";
import { useEscape } from "../mag/useEscape";
import { useBackdrop } from "../useBackdrop";
import { useDialog } from "../useDialog";
import FramePeek from "./FramePeek";
import { ScoutBody, ScoutLoading, ScoutStack } from "./ScoutStats";
import { scoutsPending, taskColors, useScouts } from "./scout";
import { clock, nearest } from "./scoutMath";

type Loaded = { id: string; stats: api.ScoutStats };

function Density({ stats }: { stats: api.ScoutStats }) {
  const bins = 60;
  const per = new Array(bins).fill(0);
  stats.checked.forEach((f, i) => {
    per[Math.min(bins - 1, Math.floor((f / Math.max(1, stats.last_frame)) * bins))] += stats.per_frame[i];
  });
  const top = Math.max(1, ...per);
  return <svg className="ag-ov-density" viewBox={`0 0 ${bins} 16`} preserveAspectRatio="none" aria-hidden="true">
    {per.map((k, b) => k ? <rect key={b} x={b + 0.1} y={16 - Math.max(1.5, (k / top) * 15)} width="0.8" height={Math.max(1.5, (k / top) * 15)}
      style={{ fill: "var(--agent)" }} /> : null)}
  </svg>;
}

function AllVideos({ taskId, loaded, colors, onPick }: {
  taskId: string; loaded: Loaded[]; colors: Map<string, string>; onPick: (id: string) => void;
}) {
  const [hover, setHover] = useState<{ id: string; i: number; x: number; y: number } | null>(null);
  const [showTable, setShowTable] = useState(true);
  const checked = loaded.reduce((s, v) => s + v.stats.checked.length, 0);
  const hits = loaded.reduce((s, v) => s + v.stats.with_hits, 0);
  const boxes = loaded.reduce((s, v) => s + v.stats.boxes, 0);
  const classes = [...colors.keys()];
  const per = (v: Loaded, name: string) => v.stats.classes.find((c) => c.name === name)?.boxes ?? 0;
  const first = loaded[0]?.stats;
  const hovered = hover ? loaded.find((v) => v.id === hover.id) : undefined;
  return <>
    <div className="ag-stats-h"><h2>Все ролики</h2></div>
    {first && <p className="ag-stats-meta">«{first.agent ?? "агент"}»{first.version ? ` v${first.version}` : ""} <Sep /> каждый {first.step}-й кадр</p>}
    <div className="ag-stats-figs">
      <div><b>{loaded.length}</b><span>{plural(loaded.length, "ролик", "ролика", "роликов")} загружено</span></div>
      <div><b>{hits.toLocaleString("ru-RU")}<small> из {checked.toLocaleString("ru-RU")}</small></b><span>кадров с находками</span></div>
      <div><b>{boxes.toLocaleString("ru-RU")}</b><span>{plural(boxes, "рамка", "рамки", "рамок")}</span></div>
      <div><b>{classes.length}</b><span>{plural(classes.length, "класс", "класса", "классов")} найдено</span></div>
    </div>
    <div className="ag-tl">
      <div className="ag-tl-h"><h4>Обзор всех классов по роликам</h4></div>
      <p className="ag-muted">Цвет — класс, высота — число находок. У каждого ролика своя шкала. Нажмите на полосу, чтобы открыть ролик.</p>
      <div className="ag-stats-strips">
        {loaded.map((v) => <div className="ag-stats-row" key={v.id}>
          <span className="ag-stats-cls"><span title={v.stats.file_name}>{v.stats.file_name}</span></span>
          <span className="ag-stats-strip ag-ov-where" role="button" tabIndex={0} aria-label={`Открыть ${v.stats.file_name}`}
            onClick={() => onPick(v.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(v.id); } }}
            onPointerMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const f = ((e.clientX - r.left) / Math.max(1, r.width)) * v.stats.last_frame;
              setHover({ id: v.id, i: nearest(v.stats.checked, f), x: e.clientX, y: e.clientY });
            }} onPointerLeave={() => setHover(null)}>
            <ScoutStack stats={v.stats} colors={colors} view={{ a: 0, b: Math.max(1, v.stats.last_frame) }} />
          </span>
          <span className="ag-stats-max">{clock(v.stats.last_frame / (v.stats.fps || 25))}</span>
        </div>)}
      </div>
    </div>
    {classes.length > 0 && <>
      <div className="ag-scout-fold-h"><h4>Классы по роликам</h4>
        <Button size="sm" variant="ghost" icon={showTable ? "chevU" : "chevD"} aria-expanded={showTable}
          onClick={() => setShowTable((v) => !v)}>{showTable ? "Скрыть таблицу" : "Показать таблицу"}</Button>
      </div>
      {showTable && <div className="ag-stats-table"><table>
        <thead><tr><th>Класс</th>{loaded.map((v) => <th key={v.id} className="n ag-ov-col" title={v.stats.file_name}>
          <button type="button" onClick={() => onPick(v.id)}>{v.stats.file_name}</button>
        </th>)}<th className="n">Всего</th></tr></thead>
        <tbody>{classes.map((name) => <tr key={name}>
          <td><span className="ag-stats-cls"><i style={{ background: colors.get(name) }} /><span title={name}>{name}</span></span></td>
          {loaded.map((v) => { const k = per(v, name); return <td key={v.id} className="n">{k ? k.toLocaleString("ru-RU") : <span className="ag-muted">—</span>}</td>; })}
          <td className="n"><b>{loaded.reduce((s, v) => s + per(v, name), 0).toLocaleString("ru-RU")}</b></td>
        </tr>)}</tbody>
      </table></div>}
    </>}
    {hover && hovered && <FramePeek taskId={taskId} videoId={hovered.id} frame={hovered.stats.checked[hover.i]} fps={hovered.stats.fps || 25}
      x={hover.x} y={hover.y} rows={hovered.stats.classes.filter((c) => c.counts[hover.i]).map((c) => ({
        name: c.name, color: colors.get(c.name) ?? "var(--dim)", count: c.counts[hover.i],
      }))} />}
  </>;
}

export default function ScoutOverview({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const scouts = useScouts(taskId);
  const colors = taskColors(scouts);
  const [loaded, setLoaded] = useState<Loaded[]>([]);
  const [finished, setFinished] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [picked, setPicked] = useState("all");
  const ids = Object.keys(scouts).sort().join(",");
  const pending = scoutsPending(scouts);
  const entries = Object.entries(scouts).sort((a, b) => a[1].file_name.localeCompare(b[1].file_name, "ru"));

  useEffect(() => {
    let alive = true;
    setLoaded([]); setFinished(0); setError(null);
    const queue = ids ? ids.split(",") : [];
    // Не забиваем соединения сотнями запросов и не ждём самого медленного ролика.
    const worker = async () => {
      while (alive && queue.length) {
        const id = queue.shift()!;
        try {
          const stats = await api.scoutStats(taskId, id);
          if (alive) setLoaded((prev) => [...prev, { id, stats }].sort((a, b) => a.stats.file_name.localeCompare(b.stats.file_name, "ru")));
        } catch (e) {
          if (alive) setError((e as Error).message);
        } finally {
          if (alive) setFinished((n) => n + 1);
        }
      }
    };
    const workers = Math.min(4, queue.length);
    for (let i = 0; i < workers; i++) void worker();
    return () => { alive = false; };
  }, [taskId, ids, retry]);

  useEscape(onClose);
  const box = useDialog();
  const current = loaded.find((v) => v.id === picked);
  const total = loaded.reduce((s, v) => s + v.stats.boxes, 0);
  const loading = pending || finished < entries.length;
  return <div className="mag-backdrop" {...useBackdrop(onClose)}>
    <div ref={box} className="mag-modal ag-ov" role="dialog" aria-modal="true" aria-label="Статистика разведки таски" tabIndex={-1}>
      <button className="ag-stats-x ag-ov-x" type="button" aria-label="Закрыть" onClick={onClose}>✕</button>
      <aside className="ag-ov-list" aria-label="Ролики разведки" tabIndex={0}>
        <h5>Разведка таски</h5>
        <button type="button" className="ag-ov-item" aria-current={picked === "all"} onClick={() => setPicked("all")}>
          <b>Все ролики</b><span className="ag-ov-meta"><span>{pending ? "…" : entries.length} {plural(entries.length, "ролик", "ролика", "роликов")}</span>
            <span>{loaded.length ? total.toLocaleString("ru-RU") : "…"} рамок{loading && loaded.length > 0 ? " · ещё загружаем" : ""}</span></span>
        </button>
        {entries.map(([id, scout]) => {
          const v = loaded.find((item) => item.id === id);
          return <button key={id} type="button" className="ag-ov-item" aria-current={picked === id} onClick={() => setPicked(id)}>
            <b title={scout.file_name}>{scout.file_name}</b>
            {v ? <Density stats={v.stats} /> : <span className="ag-ov-density ui-sk" />}
            <span className="ag-ov-meta"><span>{clock(scout.last_frame / (scout.fps || 25))}</span>
              <span>{v ? `${v.stats.boxes.toLocaleString("ru-RU")} рамок` : loading ? "Загружаем…" : "Не загружен"}</span></span>
          </button>;
        })}
      </aside>
      <div className="ag-ov-pane" tabIndex={0} aria-label="Результаты разведки">
        {error && <div className="mag-error">Не все ролики загрузились: {error} <Button size="sm" variant="ghost" disabled={loading} onClick={() => setRetry((n) => n + 1)}>Повторить</Button></div>}
        {loading && loaded.length > 0 && <p className="ag-muted" role="status">Загружаем разведку: {finished} из {entries.length} роликов. Числа пока неполные.</p>}
        {loading && (loaded.length === 0 || (picked !== "all" && !current)) && <ScoutLoading done={finished} total={entries.length} />}
        {!loading && !entries.length && <p className="ag-muted">В таске нет разведанных роликов.</p>}
        {loaded.length > 0 && picked === "all" && <AllVideos taskId={taskId} loaded={loaded} colors={colors} onPick={setPicked} />}
        {current && <><div className="ag-stats-h"><h2 title={current.stats.file_name}>{current.stats.file_name}</h2></div>
          <ScoutBody key={current.id} taskId={taskId} videoId={current.id} stats={current.stats} colors={colors} /></>}
      </div>
    </div>
  </div>;
}
