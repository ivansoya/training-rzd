import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { pollJob } from "../../api";
import {
  cutVideo,
  estimateCut,
  videoFileUrl,
  videoStripUrl,
} from "../../auth/api";
import type { CutEstimate, CutSegment, Segment, TaskVideoItem } from "../../auth/api";
import { plural } from "./ProjectsPage";

const COLORS = ["#e21a1a", "#1f6feb", "#1a7f4b", "#8957e5", "#e8590c"];
const STEPS_MS = [100, 250, 500, 1000, 2000, 5000];
const RATES = [0.25, 0.5, 1, 2];

// Тоньше 3 px отдельные засечки не различить — участок показывается штриховкой,
// а разглядеть каждый кадр можно, приблизив ленту колесом.
const MARK_MIN_PX = 3;
const MARK_CAP = 800;

export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Время в панели плеера: сотые нужны, чтобы шаг в один кадр был виден.
function fmtPrecise(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const s = Math.floor(cs / 100);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

function fmtStep(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toLocaleString("ru-RU")} с` : `${ms} мс`;
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  const units = ["Б", "КБ", "МБ", "ГБ"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ${units[i]}`;
}

function parseTime(text: string, max: number): number {
  const m = text.match(/^(\d+):(\d{1,2})$/);
  if (!m) return 0;
  return Math.min(max, (Number(m[1]) * 60 + Number(m[2])) * 1000);
}

/** Участок нарезки. id, а не индекс: выбор не должен съезжать при удалении. */
interface Seg extends Segment {
  id: number;
}

/** Одиночный кадр. thumb: null — миниатюру ещё не снимали, "" — не вышло. */
interface Single {
  ms: number;
  thumb: string | null;
}

/** План с сервера: участок в миллисекунду — это одиночный кадр. */
function splitPlan(list: CutSegment[] | undefined, duration: number) {
  const zones: Seg[] = [];
  const ones: Single[] = [];
  (list || []).forEach((s, i) => {
    if (s.end_ms - s.start_ms <= 1) ones.push({ ms: s.start_ms, thumb: null });
    else zones.push({ id: i, start_ms: s.start_ms, end_ms: s.end_ms, step_ms: s.step_ms });
  });
  if (!zones.length && !ones.length) {
    zones.push({ id: 0, start_ms: 0, end_ms: Math.min(10000, duration), step_ms: 1000 });
  }
  return { zones, ones, nextId: (list?.length || 0) + 1 };
}

interface MenuState {
  x: number;
  y: number;
  kind: "step" | "rate";
  segId?: number;
}

function framesIn(s: Segment): number {
  return Math.max(0, Math.ceil((s.end_ms - s.start_ms) / Math.max(1, s.step_ms)));
}

/** Снимок кадра из любого <video> того же origin. */
function drawThumb(v: HTMLVideoElement, w: number): string | null {
  if (v.readyState < 2 || !v.videoWidth) return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = Math.max(1, Math.round((v.videoHeight / v.videoWidth) * w));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
  try {
    return canvas.toDataURL("image/jpeg", 0.7);
  } catch {
    return null;
  }
}

export default function VideoCutModal({
  taskId,
  video,
  editable,
  startAtMs,
  onClose,
  onDone,
}: {
  taskId: string;
  video: TaskVideoItem;
  editable: boolean;
  startAtMs?: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const duration = video.duration_ms || 0;
  const frameMs = 1000 / (video.fps || 25);
  const minSpan = Math.max(500, frameMs * 20);

  // Сохранённый план — то, из чего таска нарезана; открываем ровно его.
  const [plan0] = useState(() => splitPlan(video.segments, duration));
  const nextId = useRef(plan0.nextId);
  const [segs, setSegs] = useState<Seg[]>(plan0.zones);
  const [selected, setSelected] = useState<number | null>(plan0.zones[0]?.id ?? null);
  const [singles, setSingles] = useState<Single[]>(plan0.ones);
  const [est, setEst] = useState<CutEstimate>({});
  const [confirm, setConfirm] = useState(false);
  const [job, setJob] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState(startAtMs || 0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [trackW, setTrackW] = useState(0);
  const [full, setFull] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [custom, setCustom] = useState("");

  // Окно ленты: с зумом всё время адресуется через него, а не через duration.
  const [view, setView] = useState({ start: 0, span: Math.max(1, duration) });
  const [tool, setTool] = useState<"move" | "cut">("move");
  const [sticky, setSticky] = useState(false);
  const [pending, setPending] = useState<number | null>(null);
  const [cutHover, setCutHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ id: number; edge: "l" | "r" | "body"; grab: number } | null>(null);
  const [hover, setHover] = useState<
    { ms: number; x: number; bottom: number; thumb: string | null } | null
  >(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const peekRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ x0: number; start0: number; moved: boolean } | null>(null);
  const peekWant = useRef<number | null>(null);
  const peekCache = useRef<Map<number, string>>(new Map());

  const sel = segs.find((s) => s.id === selected) || null;

  // Одиночный кадр — вырожденный участок: plan() на сервере берёт из него
  // ровно один момент и сам отсеивает совпадения с участками.
  const cutSegments = useMemo<Segment[]>(
    () => [
      ...segs.map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms, step_ms: s.step_ms })),
      ...singles.map((s) => ({ start_ms: s.ms, end_ms: s.ms + 1, step_ms: 1000 })),
    ],
    [segs, singles]
  );

  useEffect(() => {
    estimateCut(taskId, video.id, cutSegments).then(setEst).catch(() => {});
  }, [taskId, video.id, cutSegments]);

  useEffect(() => {
    if (startAtMs && videoRef.current) videoRef.current.currentTime = startAtMs / 1000;
  }, [startAtMs]);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth));
    ro.observe(el);
    setTrackW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    const onFs = () => setFull(document.fullscreenElement === leftRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Пока идёт воспроизведение, головку двигает rAF: timeupdate приходит
  // четыре раза в секунду и она заметно дёргается.
  useEffect(() => {
    if (!playing) return;
    let id = 0;
    const tick = () => {
      if (videoRef.current) setAt(videoRef.current.currentTime * 1000);
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing]);

  const clampStart = useCallback(
    (s: number, span: number) => Math.min(Math.max(0, s), Math.max(0, duration - span)),
    [duration]
  );

  // Колесо слушается нативно и не пассивно: у React onWheel нет права на
  // preventDefault, и страница уедет вместо масштаба ленты.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const r = el!.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      setView((v) => {
        if (e.shiftKey) {
          return { ...v, start: clampStart(v.start + (e.deltaY / r.width) * v.span, v.span) };
        }
        const k = e.deltaY > 0 ? 1.25 : 1 / 1.25;
        const span = Math.min(Math.max(1, duration), Math.max(minSpan, v.span * k));
        const anchor = v.start + ratio * v.span;
        return { span, start: clampStart(anchor - ratio * span, span) };
      });
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [duration, minSpan, clampStart]);

  const pct = useCallback(
    (ms: number) => ((ms - view.start) / view.span) * 100,
    [view]
  );

  function msAt(clientX: number): number {
    const r = trackRef.current!.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.round(view.start + ratio * view.span);
  }

  function seek(ms: number) {
    const t = Math.min(Math.max(0, ms), duration);
    setAt(t);
    if (videoRef.current) videoRef.current.currentTime = t / 1000;
  }

  function stepFrame(dir: number) {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    seek(v.currentTime * 1000 + dir * frameMs);
  }

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }

  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else leftRef.current?.requestFullscreen().catch(() => {});
  }

  function addSingle() {
    const v = videoRef.current;
    const now = v ? v.currentTime * 1000 : at;
    // На последней миллисекунде участок t…t+1 схлопнулся бы и кадр пропал молча.
    const ms = Math.min(Math.max(0, Math.round(now)), Math.max(0, duration - 1));
    const thumb = v ? drawThumb(v, 160) : null;
    setSingles((prev) =>
      prev.some((s) => s.ms === ms) ? prev : [...prev, { ms, thumb }].sort((a, b) => a.ms - b.ms)
    );
  }

  function patch(id: number, next: Partial<Segment>) {
    setSegs((s) => s.map((seg) => (seg.id === id ? { ...seg, ...next } : seg)));
  }

  function removeSeg(id: number) {
    setSegs((s) => s.filter((x) => x.id !== id));
    setSelected((cur) => (cur === id ? null : cur));
  }

  function addSeg(start: number, end: number) {
    const id = nextId.current++;
    setSegs((s) => [...s, { id, start_ms: start, end_ms: end, step_ms: 1000 }]);
    setSelected(id);
  }

  /** Ножницы: первый клик ставит один конец, второй — другой. */
  function placeCut(ms: number) {
    if (pending === null) {
      setPending(ms);
      return;
    }
    const a = Math.min(pending, ms);
    const b = Math.max(pending, ms);
    setPending(null);
    setCutHover(null);
    if (b - a < 200) return;
    addSeg(a, b);
    if (!sticky) setTool("move");
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (menu) setMenu(null);
        else if (pending !== null) setPending(null);
        else if (!document.fullscreenElement) onClose();
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (e.shiftKey) seek((videoRef.current?.currentTime ?? 0) * 1000 - 1000);
        else stepFrame(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (e.shiftKey) seek((videoRef.current?.currentTime ?? 0) * 1000 + 1000);
        else stepFrame(1);
      } else if ((e.key === "f" || e.key === "F" || e.key === "а" || e.key === "А") && editable) {
        e.preventDefault();
        addSingle();
      }
    }
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, editable, duration, frameMs, menu, pending]);

  // ==== лента: панорама, перемотка, растяжка участков ====

  function onTrackDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (tool === "cut") {
      placeCut(msAt(e.clientX));
      return;
    }
    trackRef.current?.setPointerCapture(e.pointerId);
    panRef.current = { x0: e.clientX, start0: view.start, moved: false };
  }

  function onTrackMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (tool === "cut" && pending !== null) {
      setCutHover(msAt(e.clientX));
      return;
    }
    if (drag) {
      const ms = msAt(e.clientX);
      setSegs((prev) =>
        prev.map((s) => {
          if (s.id !== drag.id) return s;
          if (drag.edge === "l")
            return { ...s, start_ms: Math.max(0, Math.min(ms, s.end_ms - 200)) };
          if (drag.edge === "r")
            return { ...s, end_ms: Math.min(duration, Math.max(ms, s.start_ms + 200)) };
          const len = s.end_ms - s.start_ms;
          const start = Math.min(Math.max(0, ms - drag.grab), Math.max(0, duration - len));
          return { ...s, start_ms: start, end_ms: start + len };
        })
      );
      return;
    }
    const p = panRef.current;
    if (!p) return;
    const dx = e.clientX - p.x0;
    if (!p.moved && Math.abs(dx) < 3) return;
    p.moved = true;
    const r = trackRef.current!.getBoundingClientRect();
    setView((v) => ({ ...v, start: clampStart(p.start0 - (dx / r.width) * v.span, v.span) }));
  }

  function onTrackUp(e: ReactPointerEvent<HTMLDivElement>) {
    const p = panRef.current;
    if (p && !p.moved && !drag) seek(msAt(e.clientX));
    panRef.current = null;
    setDrag(null);
  }

  /** Захват участка: первый раз только выбирает, тянуть можно уже выбранный. */
  function grabSeg(e: ReactPointerEvent<HTMLElement>, s: Seg, edge: "l" | "r" | "body") {
    e.stopPropagation();
    if (!editable) return;
    const wasSelected = selected === s.id;
    setSelected(s.id);
    if (!wasSelected) return;
    trackRef.current?.setPointerCapture(e.pointerId);
    setDrag({ id: s.id, edge, grab: msAt(e.clientX) - s.start_ms });
  }

  // ==== засечки нарезки ====

  // Уже нарезанные кадры и те, что исчезнут при применении: разницу плана и
  // таски считает сервер — у клиента нет времён существующих кадров.
  const existingSet = useMemo(() => new Set(est.existing || []), [est.existing]);

  const { marks, bands, gone } = useMemo(() => {
    const viewEnd = view.start + view.span;
    const out: { ms: number; color: string }[] = [];
    const hatch: { left: number; width: number; color: string }[] = [];
    segs.forEach((s, i) => {
      const step = Math.max(1, s.step_ms);
      const gapPx = trackW ? (step / view.span) * trackW : 0;
      if (s.end_ms < view.start || s.start_ms > viewEnd) return;
      if (gapPx < MARK_MIN_PX) {
        hatch.push({
          left: s.start_ms,
          width: s.end_ms - s.start_ms,
          color: COLORS[i % COLORS.length],
        });
        return;
      }
      const k0 = Math.max(0, Math.ceil((view.start - s.start_ms) / step));
      for (let t = s.start_ms + k0 * step; t < Math.min(s.end_ms, viewEnd); t += step) {
        out.push({ ms: t, color: COLORS[i % COLORS.length] });
        if (out.length > MARK_CAP) return;
      }
    });
    for (const s of singles) {
      if (s.ms >= view.start && s.ms <= viewEnd) out.push({ ms: s.ms, color: "#ffd43b" });
    }
    const doomed = (est.doomed || [])
      .filter((ms) => ms >= view.start && ms <= viewEnd)
      .slice(0, MARK_CAP);
    return { marks: out, bands: hatch, gone: doomed };
  }, [segs, singles, est.doomed, view, trackW]);

  /** Кадр для подсказки готовит второй, скрытый плеер — основной не дёргается.
   *  Координаты — вьюпортные: карточка выше ленты, а лента режет по overflow. */
  function peek(ms: number, offsetLeft: number) {
    const r = trackRef.current?.getBoundingClientRect();
    const x = (r?.left ?? 0) + offsetLeft;
    const bottom = window.innerHeight - (r?.top ?? 0) + 6;
    const cached = peekCache.current.get(ms) ?? null;
    setHover({ ms, x, bottom, thumb: cached });
    if (cached) return;
    const pv = peekRef.current;
    if (!pv) return;
    peekWant.current = ms;
    pv.currentTime = ms / 1000;
  }

  function onPeekSeeked() {
    const pv = peekRef.current;
    const want = peekWant.current;
    if (!pv || want === null) return;
    const url = drawThumb(pv, 168);
    if (url) peekCache.current.set(want, url);
    setHover((h) => (h && h.ms === want ? { ...h, thumb: url } : h));
    // Пустая строка вместо null — «пробовали, не вышло»: иначе очередь ниже
    // будет вечно возвращаться к этому кадру.
    setSingles((list) =>
      list.some((s) => s.ms === want && s.thumb === null)
        ? list.map((s) => (s.ms === want ? { ...s, thumb: url ?? "" } : s))
        : list
    );
  }

  // Миниатюры одиночных кадров из сохранённого плана доснимаются по одной и
  // уступают очередь подсказке под курсором — плеер на подсказки один.
  useEffect(() => {
    if (hover) return;
    const next = singles.find((s) => s.thumb === null);
    const pv = peekRef.current;
    if (!next || !pv) return;
    const cached = peekCache.current.get(next.ms);
    if (cached !== undefined) {
      setSingles((list) => list.map((s) => (s.ms === next.ms ? { ...s, thumb: cached } : s)));
      return;
    }
    peekWant.current = next.ms;
    if (Math.abs(pv.currentTime * 1000 - next.ms) < 1) onPeekSeeked();
    else pv.currentTime = next.ms / 1000;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singles, hover]);

  async function run() {
    setError(null);
    setJob(0);
    try {
      const { job_id } = await cutVideo(taskId, video.id, cutSegments);
      await pollJob(job_id, (j) => setJob(j.total ? j.processed / j.total : 0));
      onDone();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setJob(null);
    }
  }

  const zoomed = view.span < duration - 1;

  return (
    <div className="mag-backdrop">
      <div className="mag-cut" onClick={(e) => e.stopPropagation()}>
        <div className="mag-cut-head">
          <b>{video.file_name}</b>
          <span className="mag-cut-meta">
            {fmtTime(duration)} · {video.fps} к/с · {video.width}×{video.height} ·{" "}
            {fmtBytes(video.size_bytes)}
          </span>
          <span className="mag-cut-sp" />
          <button className="mag-cut-btn" type="button" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </div>

        <div className="mag-cut-body">
          <div className={full ? "mag-cut-left full" : "mag-cut-left"} ref={leftRef}>
            <div className="mag-cut-stage">
              <video
                ref={videoRef}
                src={videoFileUrl(taskId, video.id)}
                preload="metadata"
                muted
                onClick={togglePlay}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onTimeUpdate={(e) => setAt((e.target as HTMLVideoElement).currentTime * 1000)}
              />
              {/* Скрытый плеер под подсказки: перематывать основной нельзя. */}
              <video
                ref={peekRef}
                className="mag-peek"
                src={videoFileUrl(taskId, video.id)}
                preload="metadata"
                muted
                onSeeked={onPeekSeeked}
              />
            </div>

            {/* Свои контролы вместо нативных: без шага в один кадр выбрать
                конкретный кадр — угадайка, а полосы перемотки тут нет намеренно,
                её роль играет кинолента ниже. */}
            <div className="mag-player">
              <button className="mag-pl-btn" type="button" onClick={togglePlay}
                aria-label={playing ? "Пауза" : "Пуск"}>
                {playing ? "❚❚" : "▶"}
              </button>
              <button className="mag-pl-btn" type="button" onClick={() => stepFrame(-1)}
                title="Кадр назад (←)">‹|</button>
              <button className="mag-pl-btn" type="button" onClick={() => stepFrame(1)}
                title="Кадр вперёд (→)">|›</button>
              <span className="mag-pl-time">
                {fmtPrecise(at)}<i> / {fmtTime(duration)}</i>
              </span>
              {editable && (
                <>
                  <button
                    className={tool === "cut" ? "mag-pl-btn on" : "mag-pl-btn"}
                    type="button"
                    title="Нарезка: клик по ленте ставит один конец, второй клик — другой"
                    onClick={() => {
                      if (tool === "cut") setSticky((v) => !v);
                      else {
                        setTool("cut");
                        setSticky(false);
                      }
                      setPending(null);
                    }}
                  >
                    ✂{sticky && tool === "cut" ? "•" : ""}
                  </button>
                  <button className="mag-pl-take" type="button" onClick={addSingle}
                    aria-label="Снять кадр"
                    title="Снять кадр на позиции головки (F)">
                    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
                      <path
                        d="M7 4h6l1 2h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3l1-2z"
                        fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"
                      />
                      <circle cx="10" cy="11" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                  </button>
                </>
              )}
              <span className="mag-cut-sp" />
              <button
                className="mag-pl-btn wide"
                type="button"
                title="Скорость"
                onClick={(e) => {
                  const r = (e.target as HTMLElement).getBoundingClientRect();
                  setMenu({ x: r.left, y: r.top, kind: "rate" });
                }}
              >
                ×{rate.toLocaleString("ru-RU")}
              </button>
              <button className="mag-pl-btn" type="button" onClick={toggleFull}
                title="Во весь экран">{full ? "⤢" : "⛶"}</button>
            </div>

            {/* Кинолента: колесо приближает, протяжка возит окно */}
            <div
              className={tool === "cut" ? "mag-cut-track cut" : "mag-cut-track"}
              ref={trackRef}
              onPointerDown={onTrackDown}
              onPointerMove={onTrackMove}
              onPointerUp={onTrackUp}
              onPointerCancel={() => {
                panRef.current = null;
                setDrag(null);
              }}
            >
              <img
                className="mag-cut-strip"
                src={videoStripUrl(taskId, video.id)}
                alt=""
                draggable={false}
                style={{
                  width: `${(Math.max(1, duration) / view.span) * 100}%`,
                  marginLeft: `${-(view.start / view.span) * 100}%`,
                }}
              />
              {segs.map((s, i) => {
                const color = COLORS[i % COLORS.length];
                const active = selected === s.id;
                return (
                  <span
                    key={s.id}
                    className={active ? "mag-cut-seg on" : "mag-cut-seg"}
                    style={{
                      left: `${pct(s.start_ms)}%`,
                      width: `${(( s.end_ms - s.start_ms) / view.span) * 100}%`,
                      borderColor: color,
                      background: `${color}26`,
                    }}
                  >
                    {/* Ухватить участок можно только за толстые края и метку —
                        середина остаётся лентой, по ней перематывают и возят. */}
                    <b
                      style={{ background: color }}
                      onPointerDown={(e) => grabSeg(e, s, "body")}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setSelected(s.id);
                        setCustom(String(s.step_ms / 1000));
                        setMenu({ x: e.clientX, y: e.clientY, kind: "step", segId: s.id });
                      }}
                    >
                      {fmtTime(s.end_ms - s.start_ms)} · {fmtStep(s.step_ms)}
                    </b>
                    <i className="h l" style={{ background: color }}
                      onPointerDown={(e) => grabSeg(e, s, "l")} />
                    <i className="h r" style={{ background: color }}
                      onPointerDown={(e) => grabSeg(e, s, "r")} />
                  </span>
                );
              })}

              {/* Одиночные кадры — ромбики поверх ленты */}
              {singles.map((s) => (
                <span
                  key={s.ms}
                  className="mag-cut-one"
                  style={{ left: `${pct(s.ms)}%` }}
                  title={fmtPrecise(s.ms)}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    seek(s.ms);
                  }}
                />
              ))}

              {/* Незакрытая нарезка: первый конец поставлен, ждём второй */}
              {pending !== null && (
                <>
                  <span className="mag-cut-pend" style={{ left: `${pct(pending)}%` }} />
                  {cutHover !== null && (
                    <span
                      className="mag-cut-ghost"
                      style={{
                        left: `${pct(Math.min(pending, cutHover))}%`,
                        width: `${(Math.abs(cutHover - pending) / view.span) * 100}%`,
                      }}
                    />
                  )}
                </>
              )}

              {/* Единственное место, где видны кадры нарезки */}
              <span className="mag-cut-marks">
                {bands.map((b, i) => (
                  <i
                    key={`b${i}`}
                    className="band"
                    style={{
                      left: `${pct(b.left)}%`,
                      width: `${(b.width / view.span) * 100}%`,
                      backgroundImage: `repeating-linear-gradient(90deg, ${b.color} 0 1px, transparent 1px 3px)`,
                    }}
                  />
                ))}
                {gone.map((ms) => (
                  <i
                    key={`x${ms}`}
                    className="gone"
                    title="Этот кадр исчезнет при применении плана"
                    style={{ left: `${pct(ms)}%` }}
                    onPointerEnter={(e) => peek(ms, e.currentTarget.offsetLeft + 4.5)}
                    onPointerLeave={() => setHover(null)}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      seek(ms);
                    }}
                  >
                    <b />
                  </i>
                ))}
                {marks.map((m) => (
                  <i
                    key={`${m.color}-${m.ms}`}
                    className={existingSet.has(m.ms) ? "has" : undefined}
                    style={{ left: `${pct(m.ms)}%` }}
                    onPointerEnter={(e) => peek(m.ms, e.currentTarget.offsetLeft + 4.5)}
                    onPointerLeave={() => setHover(null)}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      seek(m.ms);
                    }}
                  >
                    <b style={{ background: m.color }} />
                  </i>
                ))}
              </span>

              <span className="mag-cut-head-line" style={{ left: `${pct(at)}%` }} />

              {hover && (
                <span
                  className="mag-peek-card"
                  style={{ left: `${hover.x}px`, bottom: `${hover.bottom}px` }}
                >
                  {hover.thumb ? <img src={hover.thumb} alt="" /> : <span className="mag-peek-wait" />}
                  <b>{fmtPrecise(hover.ms)}</b>
                </span>
              )}
            </div>

            <div className="mag-cut-ticks">
              <span>{fmtTime(view.start)}</span>
              <span>{zoomed ? `окно ${fmtTime(view.span)} · колесо — масштаб` : "колесо — масштаб, протяжка — сдвиг"}</span>
              <span>{fmtTime(view.start + view.span)}</span>
            </div>

            {menu && (
              <>
                <span className="mag-menu-veil" onPointerDown={() => setMenu(null)} />
                <div className="mag-menu" style={{ left: menu.x, top: menu.y }}>
                  {menu.kind === "rate"
                    ? RATES.map((r) => (
                        <button
                          key={r}
                          type="button"
                          className={r === rate ? "on" : ""}
                          onClick={() => {
                            setRate(r);
                            setMenu(null);
                          }}
                        >
                          ×{r.toLocaleString("ru-RU")}
                        </button>
                      ))
                    : (() => {
                        const seg = segs.find((s) => s.id === menu.segId);
                        if (!seg) return null;
                        return (
                          <>
                            <span className="mag-menu-h">Шаг нарезки</span>
                            {STEPS_MS.map((ms) => (
                              <button
                                key={ms}
                                type="button"
                                className={ms === seg.step_ms ? "on" : ""}
                                onClick={() => {
                                  patch(seg.id, { step_ms: ms });
                                  setMenu(null);
                                }}
                              >
                                {fmtStep(ms)}
                              </button>
                            ))}
                            <span className="mag-menu-row">
                              <input
                                type="number"
                                min="0.1"
                                step="0.1"
                                value={custom}
                                onChange={(e) => setCustom(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key !== "Enter") return;
                                  e.preventDefault();
                                  patch(seg.id, {
                                    step_ms: Math.max(100, Math.round(Number(custom) * 1000)),
                                  });
                                  setMenu(null);
                                }}
                              />
                              <span>с</span>
                            </span>
                            <button
                              type="button"
                              className="bad"
                              onClick={() => {
                                removeSeg(seg.id);
                                setMenu(null);
                              }}
                            >
                              Удалить участок
                            </button>
                          </>
                        );
                      })()}
                </div>
              </>
            )}
          </div>

          <aside className="mag-cut-right">
            {/* Свой слой прокрутки: колонка не должна вытягивать модалку под
                свой список — её высоту задаёт левая часть. */}
            <div className="mag-cut-scroll">
            <h5>Участки нарезки</h5>
            {error && <div className="mag-error">{error}</div>}

            {segs.map((s, i) => (
              <div
                className={selected === s.id ? "mag-seg-card on" : "mag-seg-card"}
                key={s.id}
                onClick={() => setSelected(s.id)}
              >
                <div className="mag-seg-row">
                  <span className="mag-seg-dot" style={{ background: COLORS[i % COLORS.length] }} />
                  <input
                    type="text"
                    value={fmtTime(s.start_ms)}
                    disabled={!editable}
                    onChange={(e) => patch(s.id, { start_ms: parseTime(e.target.value, duration) })}
                  />
                  <span className="mag-seg-arr">→</span>
                  <input
                    type="text"
                    value={fmtTime(s.end_ms)}
                    disabled={!editable}
                    onChange={(e) => patch(s.id, { end_ms: parseTime(e.target.value, duration) })}
                  />
                  <span className="mag-cut-sp" />
                  {editable && (
                    <button className="mag-icon-btn" type="button" onClick={() => removeSeg(s.id)}>
                      ✕
                    </button>
                  )}
                </div>
                <div className="mag-seg-row sub">
                  <label>шаг</label>
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={s.step_ms / 1000}
                    disabled={!editable}
                    onChange={(e) =>
                      patch(s.id, { step_ms: Math.max(100, Math.round(Number(e.target.value) * 1000)) })
                    }
                  />
                  <span className="mag-seg-unit">с</span>
                  <span className="mag-cut-sp" />
                  <b>
                    {framesIn(s)} {plural(framesIn(s), "кадр", "кадра", "кадров")}
                  </b>
                </div>
              </div>
            ))}

            {editable && (
              <button
                className="mag-dashed"
                type="button"
                onClick={() => {
                  const last = segs[segs.length - 1];
                  const start = Math.min(last ? last.end_ms : 0, duration);
                  addSeg(start, Math.min(start + 10000, duration));
                }}
              >
                + Добавить участок
              </button>
            )}

            <h5 className="mag-one-h">Отдельные кадры</h5>
            {singles.length === 0 ? (
              <p className="mag-cut-note">
                {editable
                  ? "Поставьте головку на киноленте и нажмите «+ Кадр» или клавишу F."
                  : "Не выбраны."}
              </p>
            ) : (
              <div className="mag-one-grid">
                {singles.map((s) => (
                  <div className="mag-one" key={s.ms} onClick={() => seek(s.ms)}>
                    {s.thumb ? <img src={s.thumb} alt="" /> : <span className="mag-one-noimg">кадр</span>}
                    <span className="mag-one-t">{fmtPrecise(s.ms)}</span>
                    {editable && (
                      <button
                        className="mag-icon-btn"
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSingles((x) => x.filter((k) => k.ms !== s.ms));
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className={est.error ? "mag-est bad" : "mag-est"}>
              {est.error ? (
                est.error
              ) : (
                <>
                  В плане {est.frames ?? 0}{" "}
                  {plural(est.frames ?? 0, "кадр", "кадра", "кадров")}, примерно{" "}
                  {fmtBytes(est.size_bytes ?? 0)}.
                  <span className="mag-est-diff">
                    {!est.add && !est.remove ? (
                      <span>Таска уже соответствует плану.</span>
                    ) : (
                      <>
                        {!!est.add && <b className="add">+{est.add} нарежется</b>}
                        {!!est.remove && <b className="rm">−{est.remove} исчезнет</b>}
                      </>
                    )}
                  </span>
                </>
              )}
            </div>

            {!!est.kept_accepted && (
              <p className="mag-cut-note">
                {est.kept_accepted} {plural(est.kept_accepted, "кадр", "кадра", "кадров")} уже
                приняты в датасет — они данные проекта и планом не удаляются.
              </p>
            )}
            {sel && <p className="mag-cut-note">Правая кнопка по метке участка — шаг и удаление.</p>}
            </div>
          </aside>
        </div>

        <div className="mag-cut-foot">
          {job !== null ? (
            <div className="mag-progress" style={{ flex: 1, marginTop: 0 }}>
              <div className="mag-progress-track">
                <i style={{ width: `${Math.round(job * 100)}%` }} />
              </div>
              <div className="mag-progress-lbl">
                <span>Режу кадры</span>
                <span>{Math.round(job * 100)} %</span>
              </div>
            </div>
          ) : (
            <>
              <span className="mag-cut-sp" />
              <button className="mag-ghost" type="button" onClick={onClose}>
                Отмена
              </button>
              {editable && (
                <button
                  className="mag-btn"
                  type="button"
                  disabled={!!est.error || (!est.add && !est.remove)}
                  onClick={() => (est.remove ? setConfirm(true) : run())}
                >
                  Применить
                  {est.add ? ` +${est.add}` : ""}
                  {est.remove ? ` −${est.remove}` : ""}
                </button>
              )}
            </>
          )}
        </div>

        {/* Спрашиваем только когда есть что терять: чистое добавление идёт молча. */}
        {confirm && (
          <div className="mag-confirm-veil" onClick={() => setConfirm(false)}>
            <div className="mag-confirm" onClick={(e) => e.stopPropagation()}>
              <h3>Применить план?</h3>
              <p>
                Нарежется {est.add ?? 0}{" "}
                {plural(est.add ?? 0, "кадр", "кадра", "кадров")}, исчезнет{" "}
                {est.remove ?? 0} {plural(est.remove ?? 0, "кадр", "кадра", "кадров")}.
                Удаление окончательное — вместе с файлами.
              </p>
              {!!est.remove_annotated?.length && (
                <div className="mag-confirm-bad">
                  <b>
                    {est.remove_annotated.length}{" "}
                    {plural(est.remove_annotated.length, "кадр", "кадра", "кадров")} из них
                    размечены — пропадёт{" "}
                    {est.remove_annotated.reduce((n, a) => n + a.boxes, 0)}{" "}
                    {plural(
                      est.remove_annotated.reduce((n, a) => n + a.boxes, 0),
                      "бокс",
                      "бокса",
                      "боксов"
                    )}
                    .
                  </b>
                  <ul>
                    {est.remove_annotated.slice(0, 12).map((a) => (
                      <li key={a.ms}>
                        {fmtPrecise(a.ms)} — {a.boxes}{" "}
                        {plural(a.boxes, "бокс", "бокса", "боксов")}
                      </li>
                    ))}
                  </ul>
                  {est.remove_annotated.length > 12 && (
                    <span>…и ещё {est.remove_annotated.length - 12}</span>
                  )}
                </div>
              )}
              <div className="mag-confirm-foot">
                <button className="mag-ghost" type="button" onClick={() => setConfirm(false)}>
                  Отмена
                </button>
                <button
                  className="mag-btn"
                  type="button"
                  onClick={() => {
                    setConfirm(false);
                    run();
                  }}
                >
                  Применить
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
