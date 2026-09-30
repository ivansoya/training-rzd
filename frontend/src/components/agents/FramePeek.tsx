// Карточка при наведении на разведку: кадр ролика и что на нём нашлось.
//
// Решение владельца (24.09.2026): кадр — только в карточке, ленты кадров под
// шкалой нет. Карточка висит поверх окна (position: fixed) и у края экрана
// переходит на другую сторону указателя, чтобы её не резало.

import { useEffect, useState } from "react";
import { videoFrameUrl } from "../../auth/api";
import { plural } from "../ru";
import { clock } from "./scoutMath";

const WIDTH = 256;
// Кадр просим, только когда указатель задержался: иначе проводка мышью по
// часовому ролику заказывала бы у сервера сотни кадров подряд.
const SETTLE_MS = 160;

export interface PeekRow {
  name: string;
  color: string;
  count: number;
}

export default function FramePeek({ taskId, videoId, frame, fps, x, y, rows, focus }: {
  taskId: string;
  videoId: string;
  frame: number;
  fps: number;
  /** Указатель, px окна. */
  x: number;
  y: number;
  /** Классы кадра — только те, что нашлись. */
  rows: PeekRow[];
  /** Класс строки под указателем — выделяется. */
  focus?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setSrc(null);
    setLoaded(false);
    const t = window.setTimeout(() => setSrc(`${videoFrameUrl(taskId, videoId, frame)}&w=320`), SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [taskId, videoId, frame]);

  const total = rows.reduce((s, r) => s + r.count, 0);
  const left = x + WIDTH + 24 > window.innerWidth ? x - WIDTH - 16 : x + 16;
  // Снизу места нет — карточка встаёт над указателем. 330 — её высота с кадром
  // и тремя-четырьмя строками; точнее не нужно, важно не уйти за край.
  const top = y + 330 > window.innerHeight ? Math.max(8, y - 330) : y + 18;
  return (
    <div className="ag-peek" style={{ left, top, width: WIDTH }} role="tooltip">
      <div className={loaded ? "ag-peek-img on" : "ag-peek-img"}>
        {src && <img src={src} alt="" onLoad={() => setLoaded(true)} />}
      </div>
      <div className="ag-peek-body">
        <div className="ag-peek-h"><b>Кадр {frame.toLocaleString("ru-RU")}</b><span>{clock(frame / fps)}</span></div>
        {rows.length === 0 ? (
          <p>ничего не найдено</p>
        ) : (
          <>
            {rows.map((r) => (
              <div key={r.name} className={r.name === focus ? "ag-peek-row on" : "ag-peek-row"}>
                <i style={{ background: r.color }} /><span>{r.name}</span><b>{r.count}</b>
              </div>
            ))}
            {rows.length > 1 && (
              <div className="ag-peek-row sum"><i /><span>всего</span><b>{total} {plural(total, "рамка", "рамки", "рамок")}</b></div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
