// Нарезка ролика на кадры: плеер, кинолента с участками, разведка под ней; справа план и итог.
//
// Участок рисуется протяжкой по ленте («Ножницы», C); «Рука» (H) и Shift+протяжка двигают
// приближенное окно, щелчок без движения перематывает. План режет сервер; окно после нарезки
// не закрывается — нарезают подходами.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { pollJob } from "../../api/jobs";
import { cutVideo, estimateCut, videoFileUrl } from "../../auth/api";
import type { CutEstimate, CutSegment, Segment, TaskVideoItem } from "../../auth/api";
import { Button, Dialog, Icon, Input, MenuItem, Meta, Notice, Popover, cx, layerDepth, useEscape } from "../../ui";
import { plural, ru } from "../ru";
import VideoStrip from "./VideoStrip";
import { NumInput } from "../NumInput";
import { ScoutBand, scoutHits, taskColors, useScouts } from "../agents/scout";
import { scoutStats } from "../../api/agents";
import type { ScoutStats } from "../../api/agents";
import { scoutFrameAt } from "../editor/review";
import Marks from "../editor/Marks";
import { fmtConf } from "./BoxCanvas";
import { useConfirm } from "./tasks/Confirm";

// Цвета участков — ряды палитры; брендовый красный значит действие или брак.
const TONES = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)"];
const STEPS_MS = [100, 250, 500, 1000, 2000, 5000];
const RATES = [0.25, 0.5, 1, 2];
// Короче — случайный щелчок с дрожью руки, а не участок.
const MIN_SEG_MS = 200;

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

export function fmtStep(ms: number): string {
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

/** «1:05», «1:05.25» или голые секунды «65,5». Не время — null, а не ноль:
 *  ноль превращал недонабранный конец участка в «0:00». */
export function parseTime(text: string, max: number): number | null {
  const m = text.trim().replace(",", ".").match(/^(?:(\d+):)?(\d+(?:\.\d*)?)$/);
  if (!m || (m[1] !== undefined && Number(m[2]) >= 60)) return null;
  return Math.min(max, Math.round((Number(m[1] || 0) * 60 + Number(m[2])) * 1000));
}

/** Время для правки: доли секунды показываем, только если они есть. */
const fmtEdit = (ms: number) => (ms % 1000 ? fmtPrecise(ms) : fmtTime(ms));

/** Поле времени с черновиком: разбор на уходе и по Enter, а не на каждой букве. */
function TimeInput({ ms, max, disabled, label, onValue }: {
  ms: number; max: number; disabled?: boolean; label: string; onValue: (ms: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const bad = draft !== null && parseTime(draft, max) === null;
  const commit = () => {
    const got = draft === null ? null : parseTime(draft, max);
    if (got !== null) onValue(got);
    setDraft(null);
  };
  return (
    <Input className="vc-time ui-mono" value={draft ?? fmtEdit(ms)} disabled={disabled} invalid={bad} aria-label={label}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { e.stopPropagation(); setDraft(null); }
      }} />
  );
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
function splitPlan(list: CutSegment[] | undefined) {
  const zones: Seg[] = [];
  const ones: Single[] = [];
  (list || []).forEach((s, i) => {
    if (s.end_ms - s.start_ms <= 1) ones.push({ ms: s.start_ms, thumb: null });
    else zones.push({ id: i, start_ms: s.start_ms, end_ms: s.end_ms, step_ms: s.step_ms });
  });
  // Пустой план остаётся пустым: готовый участок «первые 10 секунд» навязывал кусок ролика.
  return { zones, ones, nextId: (list?.length || 0) + 1 };
}

/** Отпечаток плана: те же участки в любом порядке — тот же план. У одиночного кадра шаг не сравниваем. */
function planKey(list: { start_ms: number; end_ms: number; step_ms: number }[]): string {
  return JSON.stringify(
    list
      .map((s) => [s.start_ms, s.end_ms, s.end_ms - s.start_ms <= 1 ? 0 : s.step_ms])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
  );
}

/** Сколько кадров даст участок плана. Правило одно на окно нарезки и на карточку ролика. */
export function framesIn(s: { start_ms: number; end_ms: number; step_ms: number }): number {
  return Math.max(0, Math.ceil((s.end_ms - s.start_ms) / Math.max(1, s.step_ms)));
}

/** Кинолента окна: настоящие кадры видимого промежутка, снятые своим скрытым плеером.
 *  Общая лента с сервера при увеличении растягивалась в мыло, а выбирают именно по кадрам. */
function WindowStrip({ src, from, span, className }: { src: string; from: number; span: number; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || span <= 0) return undefined;
    let live = true;
    // Перемотка — это сеть и разжатие; ждём, пока окно устоится.
    const timer = window.setTimeout(() => void fill(), 260);

    async function seekTo(seconds: number): Promise<boolean> {
      return new Promise((resolve) => {
        if (!video) return resolve(false);
        let done = false;
        const finish = (ok: boolean) => {
          if (done) return;
          done = true;
          video.removeEventListener("seeked", onSeeked);
          window.clearTimeout(guard);
          resolve(ok);
        };
        const onSeeked = () => finish(true);
        // Перемотка может и не ответить — на битом месте или пока едут байты.
        const guard = window.setTimeout(() => finish(false), 4000);
        video.addEventListener("seeked", onSeeked);
        try {
          video.currentTime = seconds;
        } catch {
          finish(false);
        }
      });
    }

    async function fill() {
      if (!live || !canvas || !video) return;
      const box = canvas.getBoundingClientRect();
      if (!box.width) return;
      // Уже 80 px кадр не читается, шире 130 их слишком мало, чтобы попасть по месту.
      const tiles = Math.max(1, Math.round(box.width / 104));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(box.width * dpr);
      canvas.height = Math.round(box.height * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, box.width, box.height);
      const w = box.width / tiles;
      for (let i = 0; i < tiles; i += 1) {
        if (!live) return;
        // Середина плитки: кадр отвечает за тот кусок ленты, под которым нарисован.
        const ms = from + ((i + 0.5) / tiles) * span;
        if (!(await seekTo(ms / 1000))) continue;
        if (!live || !video.videoWidth) return;
        const scale = box.height / video.videoHeight;
        const drawW = video.videoWidth * scale;
        ctx.save();
        ctx.beginPath();
        ctx.rect(i * w, 0, w, box.height);
        ctx.clip();
        ctx.drawImage(video, i * w + (w - drawW) / 2, 0, drawW, box.height);
        ctx.restore();
        setReady(true);
      }
    }

    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [src, from, span]);

  return (
    <>
      <video ref={videoRef} className="vc-hidden" src={src} preload="auto" muted />
      <canvas ref={canvasRef} className={className} style={{ opacity: ready ? undefined : 0 }} />
    </>
  );
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

type Tool = "cut" | "hand";
/** Что делает протяжка по ленте сейчас: двигает окно или рисует участок. */
type Gesture = { kind: "pan"; x0: number; start0: number; moved: boolean } | { kind: "draw"; x0: number; a: number; b: number; moved: boolean };

export default function VideoCutModal({ taskId, video, editable, startAtMs, onClose, onDone }: {
  taskId: string;
  video: TaskVideoItem;
  editable: boolean;
  startAtMs?: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const duration = video.duration_ms || 0;
  const frameMs = 1000 / (video.fps || 25);
  // Шаг короче периода кадра давал два момента на один кадр.
  const minStep = Math.max(100, Math.ceil(frameMs));
  const scouts = useScouts(taskId);
  const scout = scouts[video.id];
  // Разведку показывают и прячут (R) — тот же выбор, что в редакторе ролика
  const [scoutShown, setScoutShown] = useState(() => {
    try { return window.localStorage.getItem("mag.video.scout") !== "0"; } catch { return true; }
  });
  const showScout = useCallback((v: boolean) => {
    setScoutShown(v);
    try { window.localStorage.setItem("mag.video.scout", v ? "1" : "0"); } catch { /* не запомнится */ }
  }, []);
  // Покадровые находки разведки — точкам полосы и призракам поверх плеера
  const [found, setFound] = useState<ScoutStats | null>(null);
  const [scoutOff, setScoutOff] = useState<Set<string>>(new Set());
  const scoutAt = scout?.created_at;
  useEffect(() => {
    if (!scoutAt) { setFound(null); return; }
    let alive = true;
    scoutStats(taskId, video.id).then((s) => alive && setFound(s)).catch(() => {});
    return () => { alive = false; };
  }, [taskId, video.id, scoutAt]);
  const minSpan = Math.max(500, frameMs * 20);
  const src = videoFileUrl(taskId, video.id);

  // Сохранённый план — то, из чего таска нарезана; открываем ровно его.
  const [plan0] = useState(() => splitPlan(video.segments));
  const nextId = useRef(plan0.nextId);
  const [segs, setSegs] = useState<Seg[]>(plan0.zones);
  const [selected, setSelected] = useState<number | null>(plan0.zones[0]?.id ?? null);
  const [singles, setSingles] = useState<Single[]>(plan0.ones);
  const [est, setEst] = useState<CutEstimate>({});
  /** Идёт ли нарезка: доля с сервера прыгает рывками по участкам и врёт. */
  const [busy, setBusy] = useState(false);
  /** Нарезка кончилась: сколько кадров прибавилось и сколько ушло. */
  const [done, setDone] = useState<{ added: number; removed: number } | null>(null);
  /** Счётчик применённых планов: двигает пересчёт оценки, сами участки после нарезки те же. */
  const [applied, setApplied] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Плеер не играет формат (AVI, HEVC без декодера): говорим это, а не молчим чёрным.
  const [unplayable, setUnplayable] = useState(false);
  const [at, setAt] = useState(startAtMs || 0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [trackW, setTrackW] = useState(0);
  const [full, setFull] = useState(false);
  // Меню шага по правой кнопке на метке участка — у курсора.
  const [menu, setMenu] = useState<{ x: number; y: number; segId: number } | null>(null);
  const [custom, setCustom] = useState("");
  const [confirm, confirmNode] = useConfirm();

  // Окно ленты: с зумом всё адресуется через него, а не через duration.
  const [view, setView] = useState({ start: 0, span: Math.max(1, duration) });
  const [tool, setTool] = useState<Tool>(editable ? "cut" : "hand");
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [drag, setDrag] = useState<{ id: number; edge: "l" | "r" | "body"; grab: number } | null>(null);
  const [hover, setHover] = useState<{ ms: number; x: number; bottom: number; thumb: string | null } | null>(null);
  // Скрытый плеер под превью узнал ролик — можно перематывать
  const [peekReady, setPeekReady] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const peekRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const peekWant = useRef<number | null>(null);
  const peekCache = useRef<Map<number, string>>(new Map());
  // Глубина стопки Esc с самим окном: выше неё открыто что-то поверх, и клавиши окна молчат.
  const depth = useRef(0);
  useEffect(() => {
    depth.current = layerDepth();
  }, []);
  useEscape(() => setMenu(null), Boolean(menu));

  // Одиночный кадр — вырожденный участок: plan() на сервере берёт из него ровно один момент.
  const cutSegments = useMemo<Segment[]>(
    () => [
      ...segs.map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms, step_ms: s.step_ms })),
      ...singles.map((s) => ({ start_ms: s.ms, end_ms: s.ms + 1, step_ms: 1000 })),
    ],
    [segs, singles]
  );

  useEffect(() => {
    estimateCut(taskId, video.id, cutSegments).then(setEst).catch(() => {});
  }, [taskId, video.id, cutSegments, applied]);

  // Что сейчас нарезано — от него меряем «план не применён». Двигается после удачной нарезки.
  const savedPlan = useRef(planKey(video.segments || []));

  /** Уйти из окна. Неприменённый план не теряется молча; пока режется, уйти нельзя. */
  const requestClose = async () => {
    if (busy) return;
    if (editable && planKey(cutSegments) !== savedPlan.current) {
      const ok = await confirm({ title: "План не применён", icon: "x", danger: true, ok: "Закрыть без нарезки",
        desc: "Участки и отдельные кадры, отмеченные здесь, пропадут." });
      if (!ok) return;
    }
    onClose();
  };

  useEffect(() => {
    if (startAtMs && videoRef.current) videoRef.current.currentTime = startAtMs / 1000;
  }, [startAtMs]);

  // Лента появляется вместе с окном, а не при монтировании: Radix вставляет его в портал позже.
  const trackBox = useCallback((el: HTMLDivElement | null) => {
    (trackRef as { current: HTMLDivElement | null }).current = el;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth));
    ro.observe(el);
    setTrackW(el.clientWidth);
  }, []);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    const onFs = () => setFull(document.fullscreenElement === leftRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Пока идёт воспроизведение, головку двигает rAF: timeupdate приходит четыре раза в секунду.
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

  const clampStart = useCallback((s: number, span: number) => Math.min(Math.max(0, s), Math.max(0, duration - span)), [duration]);

  // Колесо у указателя приближает (`ratio` — доля ширины), с Shift — сдвигает. Общее у ленты и разведки.
  const zoomAt = useCallback((ratio: number, deltaY: number, shift: boolean, width: number) => {
    setView((v) => {
      if (shift) return { ...v, start: clampStart(v.start + (deltaY / Math.max(1, width)) * v.span, v.span) };
      const k = deltaY > 0 ? 1.25 : 1 / 1.25;
      const span = Math.min(Math.max(1, duration), Math.max(minSpan, v.span * k));
      const anchor = v.start + ratio * v.span;
      return { span, start: clampStart(anchor - ratio * span, span) };
    });
  }, [duration, minSpan, clampStart]);

  // Колесо слушается нативно и не пассивно: у React onWheel нет права на preventDefault.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const r = el!.getBoundingClientRect();
      zoomAt(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), e.deltaY, e.shiftKey, r.width);
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, trackW]);

  const pct = useCallback((ms: number) => ((ms - view.start) / view.span) * 100, [view]);

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
    setSingles((prev) => (prev.some((s) => s.ms === ms) ? prev : [...prev, { ms, thumb }].sort((a, b) => a.ms - b.ms)));
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

  // Какой проверенный кадр сейчас на экране: при проигрывании находка держится полшага
  // до и после своего кадра (не дольше секунды), на паузе — только ровно свой кадр
  const scoutHere = found && scoutShown
    ? scoutFrameAt(found.checked, Math.floor(at / frameMs + 1e-6), playing,
      Math.min(Math.ceil((found.step || 1) / 2), Math.round(1000 / frameMs)))
    : null;
  const ghostHits = scoutHere === null ? [] : scoutHits(found, scoutHere, taskColors(scouts), scoutOff);
  const scoutRef = useRef(!!scout);
  scoutRef.current = !!scout;
  const scoutShownRef = useRef(scoutShown);
  scoutShownRef.current = scoutShown;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (layerDepth() > depth.current || busy || done) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      // По коду клавиши: в русской раскладке key у этих клавиш другой.
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
        e.preventDefault();
        const dir = e.code === "ArrowLeft" ? -1 : 1;
        if (e.shiftKey) seek((videoRef.current?.currentTime ?? 0) * 1000 + dir * 1000);
        else stepFrame(dir);
      } else if (editable && e.code === "KeyF") {
        e.preventDefault();
        addSingle();
      } else if (editable && (e.code === "KeyC" || e.code === "KeyH")) {
        e.preventDefault();
        setTool(e.code === "KeyC" ? "cut" : "hand");
      } else if (e.code === "KeyR" && scoutRef.current) {
        e.preventDefault();
        showScout(!scoutShownRef.current);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, duration, frameMs, busy, done]);

  // ==== лента: протяжка рисует участок или двигает окно, щелчок перематывает ====

  function onTrackDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button === 2) return;
    trackRef.current?.setPointerCapture(e.pointerId);
    const pan = !editable || tool === "hand" || e.shiftKey || e.button === 1;
    const ms = msAt(e.clientX);
    setGesture(pan ? { kind: "pan", x0: e.clientX, start0: view.start, moved: false } : { kind: "draw", x0: e.clientX, a: ms, b: ms, moved: false });
  }

  function onTrackMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (drag) {
      const ms = msAt(e.clientX);
      setSegs((prev) => prev.map((s) => {
        if (s.id !== drag.id) return s;
        if (drag.edge === "l") return { ...s, start_ms: Math.max(0, Math.min(ms, s.end_ms - MIN_SEG_MS)) };
        if (drag.edge === "r") return { ...s, end_ms: Math.min(duration, Math.max(ms, s.start_ms + MIN_SEG_MS)) };
        const len = s.end_ms - s.start_ms;
        const start = Math.min(Math.max(0, ms - drag.grab), Math.max(0, duration - len));
        return { ...s, start_ms: start, end_ms: start + len };
      }));
      return;
    }
    const g = gesture;
    if (!g) return;
    const dx = e.clientX - g.x0;
    if (!g.moved && Math.abs(dx) < 3) return;
    if (g.kind === "draw") {
      setGesture({ ...g, b: msAt(e.clientX), moved: true });
      return;
    }
    const r = trackRef.current!.getBoundingClientRect();
    setGesture({ ...g, moved: true });
    setView((v) => ({ ...v, start: clampStart(g.start0 - (dx / r.width) * v.span, v.span) }));
  }

  function onTrackUp(e: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture;
    setGesture(null);
    if (drag) {
      setDrag(null);
      return;
    }
    if (!g) return;
    if (!g.moved) {
      seek(msAt(e.clientX));
      return;
    }
    if (g.kind === "draw") {
      const a = Math.min(g.a, g.b);
      const b = Math.max(g.a, g.b);
      if (b - a >= MIN_SEG_MS) addSeg(a, b);
    }
  }

  /** Захват участка: первый раз только выбирает, тянуть можно уже выбранный. */
  function grabSeg(e: ReactPointerEvent<HTMLElement>, s: Seg, edge: "l" | "r" | "body") {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (!editable) return;
    const wasSelected = selected === s.id;
    setSelected(s.id);
    if (!wasSelected) return;
    trackRef.current?.setPointerCapture(e.pointerId);
    setDrag({ id: s.id, edge, grab: msAt(e.clientX) - s.start_ms });
  }

  // ==== засечки нарезки ====

  // Уже нарезанные кадры и те, что исчезнут при применении: разницу плана и таски считает сервер.
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
        hatch.push({ left: s.start_ms, width: s.end_ms - s.start_ms, color: TONES[i % TONES.length] });
        return;
      }
      const k0 = Math.max(0, Math.ceil((view.start - s.start_ms) / step));
      for (let t = s.start_ms + k0 * step; t < Math.min(s.end_ms, viewEnd); t += step) {
        out.push({ ms: t, color: TONES[i % TONES.length] });
        if (out.length > MARK_CAP) return;
      }
    });
    for (const s of singles) if (s.ms >= view.start && s.ms <= viewEnd) out.push({ ms: s.ms, color: "var(--fg)" });
    const doomed = (est.doomed || []).filter((ms) => ms >= view.start && ms <= viewEnd).slice(0, MARK_CAP);
    return { marks: out, bands: hatch, gone: doomed };
  }, [segs, singles, est.doomed, view, trackW]);

  /** Кадр для подсказки готовит второй, скрытый плеер — основной не дёргается. Координаты вьюпортные. */
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
    // Кадр после перемотки ещё не разжат — снимем, когда будет: иначе превью вышло бы пустым навсегда
    if (pv.readyState < 2) {
      pv.addEventListener("loadeddata", onPeekSeeked, { once: true });
      return;
    }
    const url = drawThumb(pv, 168);
    if (url) peekCache.current.set(want, url);
    setHover((h) => (h && h.ms === want ? { ...h, thumb: url } : h));
    // Пустая строка — «пробовали, не вышло»: иначе очередь ниже вечно возвращалась бы к этому кадру.
    setSingles((list) => list.some((s) => s.ms === want && s.thumb === null)
      ? list.map((s) => (s.ms === want ? { ...s, thumb: url ?? "" } : s)) : list);
  }

  // Миниатюры одиночных кадров из сохранённого плана доснимаются по одной и уступают подсказке.
  // Ждут, пока скрытый плеер узнает ролик: перемотка до метаданных просто теряется.
  useEffect(() => {
    if (hover || !peekReady) return;
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
  }, [singles, hover, peekReady]);

  /** Нарезать по плану. Окно после нарезки не закрывается: нарезают подходами. */
  async function run() {
    setError(null);
    setDone(null);
    setBusy(true);
    try {
      const { job_id } = await cutVideo(taskId, video.id, cutSegments);
      // Итог — что сделано, а не что заказывали.
      const made = await pollJob<{ frames?: number; removed?: number }>(job_id, () => {});
      const plan = { added: made?.frames ?? 0, removed: made?.removed ?? 0 };
      // Таску перечитываем сразу: числа на карточке ролика должны сойтись к возврату.
      onDone();
      // Участки те же, но кадры по ним уже есть — без пересчёта «Применить» звало бы нарезать их снова.
      setApplied((n) => n + 1);
      savedPlan.current = planKey(cutSegments);
      setDone(plan);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Спрашиваем только когда есть что терять: чистое добавление идёт молча. */
  async function apply() {
    if (est.remove) {
      const marked = est.remove_annotated ?? [];
      const boxes = marked.reduce((n, a) => n + a.boxes, 0);
      const ok = await confirm({
        title: "Применить план?", icon: "cut", danger: marked.length > 0, ok: "Применить",
        desc: <>
          Нарежется {ru(est.add ?? 0)} {plural(est.add ?? 0, "кадр", "кадра", "кадров")}, исчезнет {ru(est.remove)}{" "}
          {plural(est.remove, "кадр", "кадра", "кадров")}. Удаление окончательное — вместе с файлами.
          {marked.length > 0 && <b className="vc-bad"> {marked.length} {plural(marked.length, "кадр", "кадра", "кадров")} из них
            размечены — пропадёт {boxes} {plural(boxes, "бокс", "бокса", "боксов")}.</b>}
        </>,
        lines: marked.slice(0, 12).map((a) => `${fmtPrecise(a.ms)} — ${a.boxes} ${plural(a.boxes, "бокс", "бокса", "боксов")}`)
          .concat(marked.length > 12 ? [`…и ещё ${marked.length - 12}`] : []),
      });
      if (!ok) return;
    }
    void run();
  }

  const zoomed = view.span < duration - 1;
  const draw = gesture?.kind === "draw" && gesture.moved ? gesture : null;
  const menuSeg = menu ? segs.find((s) => s.id === menu.segId) ?? null : null;
  const planFacts: [string, ReactNode][] = est.error ? [] : [
    ["В плане", <span className="ui-mono">{ru(est.frames ?? 0)} {plural(est.frames ?? 0, "кадр", "кадра", "кадров")}</span>],
    ["Объём", <span className="ui-mono">≈ {fmtBytes(est.size_bytes ?? 0)}</span>],
    ["Изменится", !est.add && !est.remove ? <span className="t-muted">таска уже по плану</span> : (
      <span className="vc-diff">
        {!!est.add && <b className="add">+{ru(est.add)} нарежется</b>}
        {!!est.remove && <b className="rm">−{ru(est.remove)} исчезнет</b>}
      </span>
    )],
  ];

  return (
    <Dialog open onOpenChange={(v) => { if (!v) void requestClose(); }} closable={!busy} modalLock width={4000} height={4000} bare
      className="vc" title={video.file_name}
      desc={`${fmtTime(duration)} · ${video.fps} к/с · ${video.width}×${video.height} · ${fmtBytes(video.size_bytes)}`}
      footer={<>
        <span className="t-xs t-faint vc-keys">
          {editable ? "Протяжка по ленте — участок · Shift+протяжка — сдвиг · колесо — масштаб · F — кадр · Пробел, ← → — плеер"
            : "Колесо — масштаб · протяжка — сдвиг · Пробел, ← → — плеер"}
        </span>
        <span className="grow" />
        <Button variant="ghost" onClick={() => void requestClose()} disabled={busy}>{editable ? "Отмена" : "Закрыть"}</Button>
        {editable && (
          <Button variant="primary" icon="cut" disabled={busy || !!est.error || (!est.add && !est.remove)} onClick={() => void apply()}>
            Применить{est.add ? ` +${est.add}` : ""}{est.remove ? ` −${est.remove}` : ""}
          </Button>
        )}
      </>}>
      <div className="vc-body">
        <div className={cx("vc-left", full && "full")} ref={leftRef}>
          <div className="vc-stage">
            <video ref={videoRef} src={src} preload="metadata" muted onClick={togglePlay}
              onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
              onTimeUpdate={(e) => setAt((e.target as HTMLVideoElement).currentTime * 1000)}
              onError={() => setUnplayable(true)} />
            {unplayable && (
              <div className="vc-unplayable" role="alert">
                Браузер не воспроизводит этот формат — плеер останется чёрным. Участки можно отметить по киноленте ниже: кадры нарежет сервер.
              </div>
            )}
            {/* Находки разведки: на паузе — ровно этого кадра, при проигрывании держатся вокруг своего кадра */}
            {ghostHits.length > 0 && video.width && video.height && (
              <div className="vc-ghosts" onClick={togglePlay}>
                <Marks width={video.width} height={video.height} items={ghostHits.map((h, k) => ({
                  key: String(k), x: h.x, y: h.y, w: h.w, h: h.h, color: h.color, ghost: true,
                  label: <><i className="mag-cv-mark">◎</i>{h.name}<b className="mag-cv-conf">{fmtConf(h.conf)}</b></>,
                }))} />
              </div>
            )}
            {/* Скрытый плеер под подсказки: перематывать основной нельзя. */}
            <video ref={peekRef} className="vc-hidden" src={src} preload="auto" muted onSeeked={onPeekSeeked}
              onLoadedData={() => setPeekReady(true)} />
          </div>

          {/* Свои контролы: без шага в один кадр выбрать кадр — угадайка; перемотку играет лента ниже. */}
          <div className="vc-player">
            <Button size="sm" variant="ghost" icon={playing ? "pause" : "play"} aria-label={playing ? "Пауза (Пробел)" : "Пуск (Пробел)"} onClick={togglePlay} />
            <Button size="sm" variant="ghost" icon="chevL" aria-label="Кадр назад (←)" onClick={() => stepFrame(-1)} />
            <Button size="sm" variant="ghost" icon="chevR" aria-label="Кадр вперёд (→)" onClick={() => stepFrame(1)} />
            <span className="vc-time-now ui-mono">{fmtPrecise(at)}<i> / {fmtTime(duration)}</i></span>
            {editable && (
              <>
                <span className="vc-sep" />
                <div className="ui-seg ui-seg-sm" role="group" aria-label="Инструмент ленты">
                  <button type="button" aria-pressed={tool === "cut"} title="Ножницы (C): протяжка по ленте — новый участок" onClick={() => setTool("cut")}>
                    <Icon name="cut" size={14} />Ножницы
                  </button>
                  <button type="button" aria-pressed={tool === "hand"} title="Рука (H): протяжка двигает приближенную ленту" onClick={() => setTool("hand")}>
                    <Icon name="hand" size={14} />Рука
                  </button>
                </div>
                <Button size="sm" icon="image" kbd="F" onClick={addSingle} title="Снять кадр на позиции головки">Кадр</Button>
              </>
            )}
            <span className="grow" />
            <Popover align="end" width={140} trigger={<Button size="sm" variant="ghost" title="Скорость">×{rate.toLocaleString("ru-RU")}</Button>}>
              {(close) => RATES.map((r) => (
                <MenuItem key={r} selected={r === rate} onSelect={() => { setRate(r); close(); }}>×{r.toLocaleString("ru-RU")}</MenuItem>
              ))}
            </Popover>
            <Button size="sm" variant="ghost" icon="fit" aria-label={full ? "Выйти из полного экрана" : "Во весь экран"} onClick={toggleFull} />
          </div>

          {/* Кинолента: колесо приближает, протяжка рисует участок или двигает окно. */}
          <div className={cx("vc-track", editable && tool === "cut" ? "cut" : "hand", gesture?.kind === "pan" && gesture.moved && "panning")}
            ref={trackBox} onPointerDown={onTrackDown} onPointerMove={onTrackMove} onPointerUp={onTrackUp}
            onPointerCancel={() => { setGesture(null); setDrag(null); }}>
            {/* На общем плане хватает склеенной ленты с сервера; при увеличении кадры окна снимаются на месте. */}
            {zoomed ? <WindowStrip className="vc-strip" src={src} from={view.start} span={view.span} />
              : <VideoStrip className="vc-strip" taskId={taskId} videoId={video.id} draggable={false}
                aspect={video.width && video.height ? video.width / video.height : undefined} />}
            {segs.map((s, i) => {
              const color = TONES[i % TONES.length];
              return (
                <span key={s.id} className={cx("vc-seg", selected === s.id && "on")}
                  style={{ left: `${pct(s.start_ms)}%`, width: `${((s.end_ms - s.start_ms) / view.span) * 100}%`, "--sc": color } as CSSProperties}>
                  {/* Ухватить участок можно только за края и метку — середина остаётся лентой. */}
                  <b onPointerDown={(e) => grabSeg(e, s, "body")}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!editable) return;
                      setSelected(s.id);
                      setCustom(String(s.step_ms / 1000).replace(".", ","));
                      // Меню высотой ~340 px у нижнего края прижимается вверх.
                      setMenu({ x: Math.min(e.clientX, window.innerWidth - 220), y: Math.max(8, Math.min(e.clientY, window.innerHeight - 350)), segId: s.id });
                    }}>
                    {fmtTime(s.end_ms - s.start_ms)} · {fmtStep(s.step_ms)}
                  </b>
                  <i className="h l" onPointerDown={(e) => grabSeg(e, s, "l")} />
                  <i className="h r" onPointerDown={(e) => grabSeg(e, s, "r")} />
                </span>
              );
            })}

            {/* Одиночные кадры — ромбики поверх ленты */}
            {singles.map((s) => (
              <span key={s.ms} className="vc-one" style={{ left: `${pct(s.ms)}%` }} title={fmtPrecise(s.ms)}
                onPointerDown={(e) => { e.stopPropagation(); seek(s.ms); }} />
            ))}

            {/* Участок, который сейчас тянут */}
            {draw && (
              <span className="vc-ghost" style={{ left: `${pct(Math.min(draw.a, draw.b))}%`, width: `${(Math.abs(draw.b - draw.a) / view.span) * 100}%` }}>
                <b>{fmtTime(Math.abs(draw.b - draw.a))}</b>
              </span>
            )}

            {/* Единственное место, где видны кадры нарезки */}
            <span className="vc-marks">
              {bands.map((b, i) => (
                <i key={`b${i}`} className="band" style={{
                  left: `${pct(b.left)}%`, width: `${(b.width / view.span) * 100}%`,
                  backgroundImage: `repeating-linear-gradient(90deg, ${b.color} 0 1px, transparent 1px 3px)`,
                }} />
              ))}
              {gone.map((ms) => (
                <i key={`x${ms}`} className="gone" title="Этот кадр исчезнет при применении плана" style={{ left: `${pct(ms)}%` }}
                  onPointerEnter={(e) => peek(ms, e.currentTarget.offsetLeft + 4.5)} onPointerLeave={() => setHover(null)}
                  onPointerDown={(e) => { e.stopPropagation(); seek(ms); }}>
                  <b />
                </i>
              ))}
              {marks.map((m) => (
                <i key={`${m.color}-${m.ms}`} className={existingSet.has(m.ms) ? "has" : undefined} style={{ left: `${pct(m.ms)}%` }}
                  onPointerEnter={(e) => peek(m.ms, e.currentTarget.offsetLeft + 4.5)} onPointerLeave={() => setHover(null)}
                  onPointerDown={(e) => { e.stopPropagation(); seek(m.ms); }}>
                  <b style={{ background: m.color }} />
                </i>
              ))}
            </span>

            <span className="vc-head" style={{ left: `${pct(at)}%` }} />

            {hover && (
              <span className="vc-peek" style={{ left: `${hover.x}px`, bottom: `${hover.bottom}px` }}>
                {hover.thumb ? <img src={hover.thumb} alt="" /> : <span className="vc-peek-wait" />}
                <b>{fmtPrecise(hover.ms)}</b>
              </span>
            )}
          </div>

          {/* Разведка — полосой ровно под лентой, в её окне; шкала времени — под полосой. */}
          {(() => {
            const ticks = (
              <div className="vc-ticks">
                <span>{fmtTime(view.start)}</span>
                <span>{zoomed ? `окно ${fmtTime(view.span)}` : "весь ролик"}</span>
                <span>{fmtTime(view.start + view.span)}</span>
              </div>
            );
            return scout ? (
              <ScoutBand scout={scout} colors={taskColors(scouts)}
                view={view} at={at} editable={editable} onSeek={seek}
                shown={scoutShown} onShown={showScout}
                stats={found} onOff={setScoutOff}
                onPick={(frame) => {
                  // Середина периода кадра: на его границе плеер показал бы соседний
                  videoRef.current?.pause();
                  seek(Math.min(duration, (frame + 0.5) * frameMs));
                }}
                onPlan={(ranges) => ranges.forEach(([a, b]) => addSeg(a, Math.min(b, duration)))}
                onWheel={(ratio, deltaY, shift) => zoomAt(ratio, deltaY, shift, trackRef.current?.getBoundingClientRect().width ?? 1)}>
                {ticks}
              </ScoutBand>
            ) : ticks;
          })()}
        </div>

        <aside className="vc-side">
          {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
          <section>
            <h5>Участки <span className="ui-mono">{segs.length}</span></h5>
            {segs.length === 0 && (
              <p className="t-xs t-faint">{editable ? "Протяните по киноленте — получится участок. Края и метку потом можно двигать." : "Участков нет."}</p>
            )}
            {segs.map((s, i) => (
              <div key={s.id} className={cx("vc-card", selected === s.id && "on")} style={{ "--sc": TONES[i % TONES.length] } as CSSProperties}
                onClick={() => setSelected(s.id)}>
                <div className="vc-card-r">
                  <i className="vc-dot" />
                  <TimeInput ms={s.start_ms} max={duration} disabled={!editable} label="Начало участка" onValue={(ms) => patch(s.id, { start_ms: ms })} />
                  <Icon name="forward" size={13} />
                  <TimeInput ms={s.end_ms} max={duration} disabled={!editable} label="Конец участка" onValue={(ms) => patch(s.id, { end_ms: ms })} />
                  <span className="grow" />
                  {editable && <Button size="sm" variant="ghost" icon="x" aria-label="Убрать участок" onClick={(e) => { e.stopPropagation(); removeSeg(s.id); }} />}
                </div>
                <div className="vc-card-r sub">
                  <span className="t-xs t-muted">шаг</span>
                  <NumInput className="ui-input ui-ctl ui-mono vc-step" min={minStep / 1000} step={0.1} lazy value={s.step_ms / 1000} disabled={!editable}
                    aria-label="Шаг нарезки, с" onValue={(n) => { if (n !== undefined) patch(s.id, { step_ms: Math.max(minStep, Math.round(n * 1000)) }); }} />
                  <span className="t-xs t-muted">с</span>
                  <span className="grow" />
                  <b className="ui-mono">{ru(framesIn(s))}</b>
                  <span className="t-xs t-muted">{plural(framesIn(s), "кадр", "кадра", "кадров")}</span>
                </div>
              </div>
            ))}
          </section>

          <section>
            <h5>Отдельные кадры <span className="ui-mono">{singles.length}</span></h5>
            {singles.length === 0 ? (
              <p className="t-xs t-faint">{editable ? "Поставьте головку на нужный кадр и нажмите «Кадр» или F." : "Не выбраны."}</p>
            ) : (
              <div className="vc-ones">
                {singles.map((s) => (
                  <div key={s.ms} className="vc-one-t" role="button" tabIndex={0} onClick={() => seek(s.ms)}
                    onKeyDown={(e) => { if (e.key === "Enter") seek(s.ms); }}>
                    {s.thumb ? <img src={s.thumb} alt="" /> : <span className="vc-noimg">кадр</span>}
                    <span className="ui-mono">{fmtPrecise(s.ms)}</span>
                    {editable && (
                      <button type="button" className="rm" aria-label={`Убрать кадр ${fmtPrecise(s.ms)}`}
                        onClick={(e) => { e.stopPropagation(); setSingles((x) => x.filter((k) => k.ms !== s.ms)); }}>
                        <Icon name="x" size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="vc-sum">
            <h5>Итог</h5>
            {est.error ? <Notice tone="error">{est.error}</Notice> : <Meta items={planFacts} />}
            {!!est.kept_accepted && (
              <p className="t-xs t-muted">
                {est.kept_accepted} {plural(est.kept_accepted, "кадр", "кадра", "кадров")} уже приняты в датасет — они данные проекта и планом не удаляются.
              </p>
            )}
            {editable && segs.length > 0 && <p className="t-xs t-faint">Правая кнопка по метке участка — шаг и удаление.</p>}
          </section>
        </aside>

        {/* Работа и её итог — поверх всего окна: пока режется, план не трогают. */}
        {(busy || done) && (
          <div className="vc-veil">
            <div className="vc-work" role="status">
              {busy ? (
                <>
                  <span className="vc-spin" aria-hidden="true" />
                  <b>Режу кадры</b>
                  <span className="t-sm t-muted">Не закрывайте окно — нарезка идёт на сервере.</span>
                </>
              ) : done && (
                <>
                  <span className="vc-ok"><Icon name="tick" size={22} /></span>
                  <b>Нарезано</b>
                  <span className="t-sm t-muted">
                    {done.added ? `Прибавилось ${ru(done.added)} ${plural(done.added, "кадр", "кадра", "кадров")}` : "План применён"}
                    {done.removed ? `, ушло ${ru(done.removed)} ${plural(done.removed, "кадр", "кадра", "кадров")}` : ""}.
                  </span>
                  <div className="vc-work-f">
                    <Button onClick={() => setDone(null)}>Продолжить нарезать</Button>
                    <Button variant="primary" onClick={onClose}>Вернуться к таске</Button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {menu && menuSeg && (
        <>
          <span className="vc-menu-veil" onPointerDown={() => setMenu(null)} />
          <div className="ui-pop vc-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
            <span className="vc-menu-h">Шаг нарезки</span>
            {STEPS_MS.map((ms) => (
              <MenuItem key={ms} selected={ms === menuSeg.step_ms} onSelect={() => { patch(menuSeg.id, { step_ms: ms }); setMenu(null); }}>{fmtStep(ms)}</MenuItem>
            ))}
            <div className="vc-menu-row">
              <NumInput className="ui-input ui-ctl ui-mono" min={minStep / 1000} step={0.1} value={Number(custom.replace(",", ".")) || undefined}
                aria-label="Свой шаг, с" onValue={(n) => setCustom(n === undefined ? "" : String(n))}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  const n = Number(custom.replace(",", "."));
                  if (n > 0) patch(menuSeg.id, { step_ms: Math.max(minStep, Math.round(n * 1000)) });
                  setMenu(null);
                }} />
              <span className="t-xs t-muted">с, Enter</span>
            </div>
            <MenuItem icon="trash" danger onSelect={() => { removeSeg(menuSeg.id); setMenu(null); }}>Удалить участок</MenuItem>
          </div>
        </>
      )}
      {confirmNode}
    </Dialog>
  );
}
