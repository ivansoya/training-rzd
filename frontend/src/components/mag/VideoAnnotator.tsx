import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  closeVideoAnnotation,
  createTrack,
  deleteTrack,
  deleteTrackKey,
  ensureClass,
  errorText,
  getClasses,
  getVideoAnnotations,
  hideTrackSpan,
  markEmptyFrame,
  moveTrackKey,
  previewMaterialize,
  putTrackKey,
  reopenVideoAnnotation,
  saveFrameBoxes,
  unmarkEmptyFrame,
  updateTrack,
  videoFrameUrl,
} from "../../auth/api";
import type {
  AutoRefine,
  LabelClass,
  MaterializePreview,
  SingleWire,
  TaskVideoItem,
  VideoAnnotations,
  VideoSingleBox,
  VideoTrack,
} from "../../auth/api";
import type { RunView } from "../../api/agents";
import { pollJob } from "../../api/jobs";
import { Badge, Button, Notice, hasLayer } from "../../ui";
import BoxCanvas from "./BoxCanvas";
import { useLive } from "../../live/LiveProvider";
import type { CanvasHandle, CanvasPoint, CanvasPreview, CanvasShape } from "./BoxCanvas";
import * as poly from "./polygon";
import type { Ring } from "./polygon";
import ClassMenu from "./ClassMenu";
import { useAutoLabel } from "./useAutoLabel";
import { isUnplayable } from "./clipReader";
import AutoStatus from "./AutoStatus";
import { useClip, useClipFrame, usePlayback } from "./useClip";
import type { Clip } from "./useClip";
import { keyAt, msToFrame, stateAt, trackEnd } from "./trackMath";
import { fmtTime } from "./VideoCutModal";
import { count, plural, ru } from "../ru";
import { scoutLanes, taskColors, useScouts } from "../agents/scout";
import AgentRunDialog, { AgentRunBar } from "../agents/AgentRunDialog";
import { useConfirm } from "./tasks/Confirm";
import { EditorHead, Float, Grip, KeysDialog, SaveNote, ToolButton, ToolMenu, ZoomChip } from "../editor/Chrome";
import ClassPicker from "../editor/ClassPicker";
import AutoSettings from "../editor/AutoSettings";
import { AutoBar } from "../editor/FramePanels";
import { digitClass, isTyping, ownsArrows } from "../editor/look";
import type { KeyGroup } from "../editor/look";
import { LaneMenu, Lanes } from "../editor/Lanes";
import type { LaneAction } from "../editor/Lanes";
import { HereSide, Transport } from "../editor/VideoPanels";
import {
  DOCK_DEFAULT, clampDock, coveredSpans, itemKey, seekToTrack, singleTicks, trackNumbers,
} from "../editor/video";
import type { Item } from "../editor/video";

const KEYS: KeyGroup[] = [
  { title: "Инструменты", keys: [
    ["V", "Выбор и правка"],
    ["B", "Рамка только на этом кадре"],
    ["P", "Контур на этом кадре. Замкнуть — щелчок по первой точке или Enter"],
    ["T", "Трек: объект, живущий во времени"],
    ["A", "Полуавтомат SAM2 поверх рамки, контура или трека"],
    ["1–9", "Класс: при выбранном объекте — перекрасить его"],
    ["Del", "Удалить выбранное: у трека — ключ на этом кадре"],
  ] },
  { title: "Время", keys: [
    ["Пробел", "Играть или остановить; при показанном полуавтоматом — закрепить"],
    ["← / →", "Кадр назад и вперёд"],
    ["Shift+← / Shift+→", "На 10 кадров"],
    ["K", "Ключ выбранного трека на этом кадре"],
    ["E", "Кадр фоновый: объектов нет (ещё раз — снять)"],
  ] },
  { title: "Дорожки", keys: [
    ["Протяжка", "По линейке и дорожке — перемотка"],
    ["Ромб", "Тяните — перенести ключ; правая кнопка — заслон и снятие"],
    ["Ручки ‹ ›", "Продлить выбранный трек новым ключом"],
    ["Двойной щелчок", "Ключ на дорожке в этом месте"],
    ["Alt+протяжка", "Заслонить участок трека"],
    ["R", "Разведка по классам вместо треков"],
  ] },
  { title: "Вид", keys: [
    ["Колесо", "Зум"],
    ["Shift+протяжка", "Двигать полотно"],
    ["0", "Вписать кадр"],
    ["?", "Это окно"],
    ["Esc", "Снять начатое по шагу, на дне — выйти из разметки"],
  ] },
  { title: "Полуавтомат", keys: [
    ["Щелчок", "Объект под курсором"],
    ["Shift+щелчок", "Уточнить показанное"],
    ["Shift+правая", "Убрать участок"],
    ["Щелчок мимо", "Закрепить и начать новый"],
  ] },
];

const GREY = { name: "", color: "#9aa4ae" };
const SIDE_W = 280;

// Привычки человека, а не свойства ролика: один выбор на все ролики в этом браузере.
const SCOUT_KEY = "mag.video.scout";
const DOCK_KEY = "mag.video.dock";

function stored(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function keep(key: string, v: string) {
  try { window.localStorage.setItem(key, v); } catch { /* не запомнится — показу не мешает */ }
}

/** Внутренние названия работ человеку ни о чём не говорят: ему нужно, что происходит и сколько осталось. */
const STAGE_TEXT: Record<string, string> = {
  index: "Разбираю ролик на кадры",
  strip: "Клею киноленту",
  variant: "Готовлю ступень качества",
  chunkset: "Нарезаю ролик на куски",
  chunk: "Готовлю этот кусок",
};

function PrepareNote({ clip }: { clip: Clip }) {
  const stage = clip.progress?.kind || clip.preparing?.stage || "index";
  const total = clip.progress?.total || 0;
  const done = clip.progress?.processed || 0;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
  return (
    <span className="ve-prep" role="status">
      <i />{STAGE_TEXT[stage] || "Готовлю видео"}{percent !== null && <b className="ui-mono">{percent} %</b>}
    </span>
  );
}

/** Фигура кадра в том виде, в каком её уже отправили. Новые ещё не перечитаны:
 *  одиночная уходит полным списком кадра, трек ждёт свой id из createTrack. */
type Local = Item | { kind: "new-single" } | { kind: "new-track"; ref: { id?: string } };
type Sent = { frame: number; shapes: CanvasShape[]; items: Local[] };

/**
 * Редактор размечаемого видео «Дорожки снизу».
 *
 * Кадр всегда серверный — тот же, что уйдёт в датасет: currentTime браузера номера
 * кадра не даёт. Время объектов живёт внизу, на дорожках.
 */
export default function VideoAnnotator({
  code,
  taskId,
  taskName,
  video,
  readOnly,
  onClose,
  onChanged,
}: {
  code: string;
  taskId: string;
  taskName: string;
  video: TaskVideoItem;
  readOnly: boolean;
  onClose: () => void;
  /** Разметка ролика закрыта или открыта заново — таске пора перечитаться. */
  onChanged?: () => void;
}) {
  const fps = video.fps || 25;

  // Число кадров — из таблицы кадров ролика, а не прикидкой по длительности: разметка адресуется номером кадра.
  const clip = useClip(taskId, video.id);
  const scouts = useScouts(taskId);
  const scout = scoutLanes(scouts[video.id], taskColors(scouts));
  const [scoutOn, setScoutOn] = useState(() => stored(SCOUT_KEY) === "1");
  const toggleScout = useCallback(() => {
    setScoutOn((on) => { keep(SCOUT_KEY, on ? "0" : "1"); return !on; });
  }, []);
  const lastFrame = Math.max(
    0,
    (clip.manifest?.frame_count ?? video.frame_count ?? msToFrame(video.duration_ms || 0, fps)) - 1
  );

  const [data, setData] = useState<VideoAnnotations | null>(null);
  const [classes, setClasses] = useState<LabelClass[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [frame, setFrame] = useState(0);
  const [tool, setTool] = useState<"select" | "box" | "polygon" | "track">("select");
  // Полуавтомат — флаг поверх инструмента: с «Треком» ставит ключ трека, с «Рамкой» и «Контуром» — одиночную фигуру.
  const [autoOn, setAutoOn] = useState(false);
  const [selPart, setSelPart] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [pickedTrack, setPickedTrack] = useState<string | null>(null);
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [plan, setPlan] = useState<MaterializePreview | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ i: number | null; x: number; y: number } | null>(null);
  const [laneMenu, setLaneMenu] = useState<LaneAction | null>(null);
  const [scale, setScale] = useState(1);
  const [draft, setDraft] = useState<CanvasShape[] | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [closedAt, setClosedAt] = useState<string | null>(video.annotation_closed_at);
  const [closing, setClosing] = useState<number | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentRun, setAgentRun] = useState<RunView | null>(null);
  const [dockH, setDockH] = useState(() => Number(stored(DOCK_KEY)) || DOCK_DEFAULT);
  const dockLive = useRef(dockH);
  const [confirm, confirmNode] = useConfirm();

  const [autoPts, setAutoPts] = useState<CanvasPoint[]>([]);
  const [autoPrev, setAutoPrev] = useState<CanvasPreview | null>(null);
  const [refine, setRefine] = useState<AutoRefine>({
    detail: "auto", score_min: 0.3, min_area: 64, fill_holes: true, polygon_points: 64,
  });

  const canvas = useRef<CanvasHandle>(null);
  const body = useRef<HTMLDivElement>(null);
  const draftTimer = useRef<number>();
  const pendingCommit = useRef<(() => void) | null>(null);
  // Сохранение. Правки уходят по одной и по порядку, а сравниваются с `sent` —
  // кадром, каким его уже отправили, а не каким последний раз прочли: вторая
  // рамка, нарисованная до перечитывания, стирала на сервере первую.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const inFlight = useRef(0);
  // Номер «поколения»: после отказа правки, построенные поверх него, не уходят.
  const epoch = useRef(0);
  const failed = useRef(false);
  const sent = useRef<Sent | null>(null);
  const loadSeq = useRef(0);

  // --- кадры и проигрывание ------------------------------------------------ #
  const [quality, setQuality] = useState<string>("");
  useEffect(() => {
    if (clip.manifest && !quality) setQuality(clip.manifest.quality);
  }, [clip.manifest, quality]);
  const shown = useClipFrame(clip.reader, frame, quality);
  // Ролик, который браузер не разжимает, — чёрный холст: рисовать на нём нечего.
  const unplayable = isUnplayable(clip.error) || isUnplayable(shown.error);
  const frozen = readOnly || !data?.editable || unplayable;
  const onPlayFrame = useCallback((f: number) => setFrame(f), []);
  // Проигрывание ждёт картинку: иначе полоса убегает вперёд, кадр замирает, и кусок ролика проходит незамеченным.
  const behind = useRef(false);
  behind.current = shown.lagging;
  const caughtUp = useCallback(() => !behind.current, []);
  const { playing, speed, start, stop, changeSpeed } = usePlayback(fps, lastFrame, onPlayFrame, caughtUp);

  // --- загрузка ------------------------------------------------------------ #
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const got = await getVideoAnnotations(taskId, video.id);
      // Опоздавший ответ затёр бы на экране более позднюю правку.
      if (seq !== loadSeq.current) return;
      setData(got);
      if (!inFlight.current) setError(null);
    } catch (e) {
      if (seq === loadSeq.current) setError(errorText(e));
    }
  }, [taskId, video.id]);

  useEffect(() => { load(); }, [load]);

  const loadClasses = useCallback(() => {
    getClasses(code)
      .then((c) => {
        setClasses(c.classes);
        setActive((prev) => prev ?? (c.classes[0]?.class_index ?? null));
      })
      .catch(() => {});
  }, [code]);

  useEffect(loadClasses, [loadClasses]);

  // Класс мог уехать или исчезнуть, пока ролик открыт: у треков он сменится на сервере.
  useLive("classes", () => {
    loadClasses();
    load();
  });

  useEffect(() => {
    if (!data || !data.editable) return;
    const h = window.setTimeout(() => {
      // Отказ плана — не «плана нет»: причину показываем на кнопке «Закрыть разметку».
      previewMaterialize(taskId, video.id)
        .then((p) => { setPlan(p); setPlanError(p.error ?? null); })
        .catch((e) => { setPlan(null); setPlanError((e as Error).message); });
    }, 500);
    return () => window.clearTimeout(h);
  }, [data, taskId, video.id]);

  const byIndex = useMemo(() => {
    const m = new Map<number, LabelClass>();
    classes.forEach((c) => m.set(c.class_index, c));
    return m;
  }, [classes]);

  const labelOf = useCallback((ci: number) => byIndex.get(ci) || GREY, [byIndex]);
  const numbers = useMemo(() => trackNumbers(data?.tracks || []), [data]);

  // --- что показано на кадре ----------------------------------------------- #
  const { items, boxes, dashed } = useMemo(() => {
    const its: Item[] = [];
    const bs: CanvasShape[] = [];
    const dim = new Set<number>();
    for (const track of data?.tracks || []) {
      const state = stateAt(track, frame);
      if (!state || track.class_index === null) continue;
      if (state.hidden) dim.add(bs.length);
      its.push({ kind: "track", track, hidden: state.hidden });
      bs.push({ class_index: track.class_index, ...state.geometry });
    }
    for (const single of data?.singles || []) {
      if (single.frame_no !== frame || single.class_index === null) continue;
      its.push({ kind: "single", box: single });
      // У одиночной фигура приходит готовой: рамка или контур. Трек — всегда рамка.
      const shape = (single.shape ?? single.geometry) as Omit<CanvasShape, "class_index">;
      bs.push({ ...shape, class_index: single.class_index });
    }
    return { items: its, boxes: bs, dashed: dim };
  }, [data, frame]);

  const hiddenIdx = useMemo(
    () => new Set(items.flatMap((it, i) => (hiddenKeys.has(itemKey(it)) ? [i] : []))),
    [items, hiddenKeys]
  );
  const hiddenTracks = useMemo(
    () => new Set([...hiddenKeys].filter((k) => k.startsWith("t:")).map((k) => k.slice(2))),
    [hiddenKeys]
  );
  const toggleHidden = useCallback((key: string) => {
    setHiddenKeys((h) => {
      const next = new Set(h);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const currentTrack = useMemo(
    () => (data?.tracks || []).find((t) => t.id === pickedTrack) || null,
    [data, pickedTrack]
  );

  const trackById = useCallback(
    (id: string) => (data?.tracks || []).find((t) => t.id === id) || null,
    [data]
  );

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const pickedRef = useRef(pickedTrack);
  pickedRef.current = pickedTrack;

  // Выбор один: трек держится и на других кадрах, одиночная — только на своём.
  const pick = useCallback((i: number | null, part: number | null = null) => {
    setSelected(i);
    setSelPart(part);
    const it = i === null ? null : itemsRef.current[i];
    setPickedTrack(it?.kind === "track" ? it.track.id : null);
  }, []);

  useEffect(() => {
    if (!pickedTrack) return;
    const i = items.findIndex((it) => it.kind === "track" && it.track.id === pickedTrack);
    setSelected(i < 0 ? null : i);
  }, [items, pickedTrack]);

  useEffect(() => {
    if (!pickedRef.current) setSelected(null);
  }, [frame]);

  // --- сохранение ---------------------------------------------------------- #
  const shownNow = useRef({ frame, boxes, items });
  shownNow.current = { frame, boxes, items };
  const dataNow = useRef(data);
  dataNow.current = data;

  /** Правка — в очередь: по одной и по порядку. Отказ сбрасывает правки,
   *  построенные поверх него, и перечитывает ролик: на экране остаётся
   *  то, что на сервере, а не несохранённая рамка. */
  const guard = useCallback((fn: () => Promise<unknown>) => {
    const mine = epoch.current;
    inFlight.current += 1;
    setBusy(true);
    const run = queue.current.then(async () => {
      if (mine !== epoch.current) return;
      try {
        await fn();
      } catch (e) {
        epoch.current += 1;
        failed.current = true;
        sent.current = null;
        setDraft(null);
        setError(errorText(e));
        await load();
      }
    }).finally(() => {
      inFlight.current -= 1;
      if (!inFlight.current) {
        // Всё дошло и перечитано: дальше кадр — прочитанное.
        sent.current = null;
        setDraft(null);
        setBusy(false);
      }
    });
    queue.current = run;
    return run;
  }, [load]);

  const saveSingles = useCallback(
    (at: number, list: SingleWire[]) =>
      guard(async () => {
        await saveFrameBoxes(taskId, video.id, at, list);
        await load();
      }),
    [guard, taskId, video.id, load]
  );

  /** Одиночная фигура в том виде, в каком уходит на сервер. По `id` сервер узнаёт
   *  рамку агента: нетронутая остаётся агентовой, правленая становится вашей. */
  const asWire = useCallback(
    (s: { id?: string; class_index: number | null; shape?: unknown; geometry: unknown }): SingleWire => ({
      ...((s.shape ?? s.geometry) as Omit<SingleWire, "class_index">),
      id: s.id,
      class_index: s.class_index as number,
    }),
    []
  );

  /** Кадр таким, каким его уже отправили; не трогали — каким прочли. */
  const sentOf = useCallback((at: number): Sent | null => {
    if (sent.current && sent.current.frame === at) return sent.current;
    const now = shownNow.current;
    return now.frame === at ? { frame: at, shapes: now.boxes, items: now.items } : null;
  }, []);

  const askDrop = useCallback(async (track: VideoTrack) => {
    const ok = await confirm({
      title: `Удалить трек «${trackName(track, labelOf)}» #${numbers.get(track.id) ?? ""}?`,
      desc: `${count(track.keys.length, "ключ", "ключа", "ключей")} на кадрах ${track.start_frame}–${trackEnd(track)} уйдут вместе с ним.`,
      ok: "Удалить трек", icon: "trash", danger: true,
    });
    if (!ok) return;
    guard(async () => {
      await deleteTrack(track.id);
      setPickedTrack(null);
      await load();
    });
  }, [confirm, labelOf, numbers, guard, load]);

  /** false — холст откатить: ключ последний или его тут нет, трек удалится только по ответу. */
  const removeTrackBox = useCallback(
    (track: VideoTrack): boolean => {
      if (track.keys.length <= 1 || !keyAt(track, frame)) {
        void askDrop(track);
        return false;
      }
      guard(async () => {
        await deleteTrackKey(track.id, frame);
        await load();
      });
      return true;
    },
    [frame, guard, load, askDrop]
  );

  const commit = useCallback(
    (next: CanvasShape[]) => {
      if (frozen || active === null) return;
      // Своё рендер-замыкание — запасной вариант: отложенная отправка старого кадра срабатывает, когда на экране уже новый.
      const was = sentOf(frame) ?? { frame, shapes: boxes, items };
      const after: Local[] = [...was.items];
      let singles = false;

      if (next.length > was.shapes.length) {
        // Добавили фигуру — она последняя. Нажатие без протяжки — ещё не рамка.
        const fresh = next[next.length - 1];
        if (fresh.w < 1 || fresh.h < 1) return;
        if (tool === "track") {
          const ref: { id?: string } = {};
          after.push({ kind: "new-track", ref });
          guard(async () => {
            const track = await createTrack(taskId, video.id, {
              class_index: fresh.class_index,
              frame_no: frame,
              geometry: { x: fresh.x, y: fresh.y, w: fresh.w, h: fresh.h },
            });
            ref.id = track.id;
            setPickedTrack(track.id);
            await load();
          });
        } else {
          after.push({ kind: "new-single" });
          singles = true;
        }
      } else if (next.length < was.shapes.length) {
        let g = was.shapes.findIndex((b, i) => !same(b, next[i]));
        if (g < 0) g = was.shapes.length - 1;
        const gone = after.splice(g, 1)[0];
        if (gone.kind === "track") {
          if (!removeTrackBox(gone.track)) {
            setDraft(was.shapes);
            return;
          }
        } else if (gone.kind === "new-track") {
          const ref = gone.ref;
          guard(async () => {
            if (!ref.id) return;
            await deleteTrack(ref.id);
            await load();
          });
        } else {
          singles = true;
        }
      } else {
        // Все изменившиеся, а не первое: две правки до перечитывания — обе.
        next.forEach((box, i) => {
          if (same(box, was.shapes[i])) return;
          const item = after[i];
          const geometry = { x: box.x, y: box.y, w: box.w, h: box.h };
          // Правка положения на кадре и есть постановка ключа: с этого кадра счёт идёт от него.
          if (item.kind === "track") {
            guard(async () => {
              await putTrackKey(item.track.id, frame, { geometry });
              await load();
            });
          } else if (item.kind === "new-track") {
            guard(async () => {
              if (!item.ref.id) return;
              await putTrackKey(item.ref.id, frame, { geometry });
              await load();
            });
          } else {
            singles = true;
          }
        });
      }

      sent.current = { frame, shapes: next, items: after };
      setDraft(next);
      if (singles) {
        // Одиночные — полным списком кадра, как его видит холст: сервер заменяет список целиком.
        const list: SingleWire[] = [];
        next.forEach((box, i) => {
          const item = after[i];
          if (item.kind === "single") list.push(wireOf(box, item.box.id));
          else if (item.kind === "new-single") list.push(wireOf(box));
        });
        saveSingles(frame, list);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [frozen, active, boxes, items, tool, frame, guard, taskId, video.id, load, saveSingles, sentOf]
  );

  /** Отправить осевшую рамку сейчас, не дожидаясь таймера. Уход с кадра отправляет,
   *  а не отменяет: отмена молча теряла бокс, если в первые 350 мс нажать стрелку. */
  const flushDraft = useCallback(() => {
    window.clearTimeout(draftTimer.current);
    const run = pendingCommit.current;
    pendingCommit.current = null;
    run?.();
  }, []);

  /** Правка кадра не с холста (клавиша, меню, полуавтомат): от отправленного
   *  состояния, после ожидающей отправки — иначе та бы её откатила. */
  const apply = useCallback(
    (edit: (was: Sent) => CanvasShape[]) => {
      flushDraft();
      const was = sentOf(frame);
      if (was) commit(edit(was));
    },
    [flushDraft, sentOf, frame, commit]
  );

  /** Одиночная фигура по id: на этом кадре — через холст, на чужом — списком,
   *  прочитанным перед самой отправкой (очередь к тому времени всё перечитала). */
  const editSingle = useCallback(
    (box: VideoSingleBox, change: (s: CanvasShape) => CanvasShape | null) => {
      if (box.frame_no === frame) {
        apply((was) => was.shapes.flatMap((s, i) => {
          const it = was.items[i];
          if (it.kind !== "single" || it.box.id !== box.id) return [s];
          const got = change(s);
          return got ? [got] : [];
        }));
        return;
      }
      if (sent.current?.frame === box.frame_no) sent.current = null;
      guard(async () => {
        const list = (dataNow.current?.singles || [])
          .filter((s) => s.frame_no === box.frame_no)
          .flatMap((s) => {
            if (s.id !== box.id) return [asWire(s)];
            const got = change({ ...(asWire(s) as CanvasShape) });
            return got ? [wireOf(got, s.id)] : [];
          });
        await saveFrameBoxes(taskId, video.id, box.frame_no, list);
        await load();
      });
    },
    [frame, apply, guard, taskId, video.id, load, asWire]
  );

  /** Замкнутый контур — одиночная разметка кадра: треком контур не становится,
   *  вершины соседних ключей не сопоставить. */
  const onPolygon = useCallback(
    (ring: Ring) => {
      if (frozen || active === null) return;
      const box = poly.bounds([ring]);
      if (!box) return;
      apply((was) => [...was.shapes, { class_index: active, kind: "polygon", parts: [ring], ...box }]);
      setTool("select");
    },
    [frozen, active, apply]
  );

  /** Пока тянут рамку, холст сообщает каждое положение; отправляем осевшее. */
  const onBoxes = useCallback(
    (next: CanvasShape[]) => {
      setDraft(next);
      window.clearTimeout(draftTimer.current);
      pendingCommit.current = () => commit(next);
      draftTimer.current = window.setTimeout(flushDraft, 350);
    },
    [commit, flushDraft]
  );

  useEffect(() => {
    flushDraft();
    // Вернулись на кадр, чьи правки ещё в пути, — показываем их, а не прочитанное.
    setDraft(sent.current && sent.current.frame === frame ? sent.current.shapes : null);
  }, [frame, video.id, flushDraft]);

  // Закрыли вкладку в те же 350 мс — рамка тоже уходит; пока правки в пути, браузер переспросит.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!inFlight.current && !pendingCommit.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("pagehide", flushDraft);
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("pagehide", flushDraft);
      window.removeEventListener("beforeunload", warn);
      flushDraft();
    };
  }, [flushDraft]);

  /** Дождаться, пока все правки дойдут; false — сервер отказал, ошибка на экране. */
  const settle = useCallback(async () => {
    failed.current = false;
    flushDraft();
    await queue.current;
    return !failed.current;
  }, [flushDraft]);

  const closeEditor = useCallback(async () => {
    if (await settle()) onClose();
  }, [settle, onClose]);

  // Перечитали посреди очереди — на экране остаются свои правки, а не прочитанное.
  useEffect(() => { if (!inFlight.current) setDraft(null); }, [data]);

  const patchTrack = useCallback(
    (track: VideoTrack, body: Parameters<typeof updateTrack>[1]) =>
      guard(async () => {
        await updateTrack(track.id, body);
        await load();
      }),
    [guard, load]
  );

  // Пометка «фоновый» действует, только пока кадр свободен — по присутствию объекта, как считает сервер.
  const frameBusy = useCallback(
    (at: number) =>
      (data?.singles || []).some((b) => b.frame_no === at) ||
      (data?.tracks || []).some((t) => {
        const state = stateAt(t, at);
        return state !== null && !state.hidden;
      }),
    [data]
  );
  const marks = useMemo(
    () => (data?.empty_frames || []).map((at) => ({ frame: at, on: !frameBusy(at) })),
    [data, frameBusy]
  );
  const markedHere = (data?.empty_frames || []).includes(frame);
  const busyHere = frameBusy(frame);

  const toggleEmpty = useCallback(() => {
    if (frozen) return;
    if (!markedHere && busyHere) return;
    guard(async () => {
      if (markedHere) await unmarkEmptyFrame(taskId, video.id, frame);
      else await markEmptyFrame(taskId, video.id, frame);
      await load();
    });
  }, [frozen, markedHere, busyHere, guard, load, taskId, video.id, frame]);

  const putKey = useCallback(() => {
    if (frozen || !currentTrack || !stateAt(currentTrack, frame)) return;
    guard(async () => { await putTrackKey(currentTrack.id, frame, {}); await load(); });
  }, [frozen, currentTrack, frame, guard, load]);

  // --- навигация ----------------------------------------------------------- #
  const seek = useCallback((f: number) => {
    stop();
    setFrame(Math.max(0, Math.min(lastFrame, f)));
  }, [lastFrame, stop]);

  const go = useCallback(
    (delta: number) => {
      stop();
      setFrame((f) => Math.max(0, Math.min(lastFrame, f + delta)));
    },
    [lastFrame, stop]
  );

  const togglePlay = useCallback(() => {
    if (playing) stop();
    else start(frame >= lastFrame ? 0 : frame);
  }, [playing, stop, start, frame, lastFrame]);

  /** Трек с дорожки: выбрать и, если на этом кадре его нет, перейти к его жизни. */
  const selectTrack = useCallback((id: string) => {
    const t = trackById(id);
    setPickedTrack(id);
    setSelPart(null);
    if (t) {
      const to = seekToTrack(t, frame);
      if (to !== frame) seek(to);
    }
  }, [trackById, frame, seek]);

  // --- действия с дорожек -------------------------------------------------- #
  const onLane = useCallback(
    (action: LaneAction) => {
      const track = trackById(action.trackId);
      if (!track) return;
      stop();
      if (frozen && action.kind !== "seek" && action.kind !== "menu") return;
      switch (action.kind) {
        case "seek":
          setFrame(action.frame);
          break;
        case "move-key":
          guard(async () => {
            await moveTrackKey(track.id, action.from!, action.frame);
            await load();
          });
          break;
        case "add-key":
        case "set-start":
        case "set-end":
          guard(async () => {
            const keys = [...track.keys].sort((a, b) => a.frame_no - b.frame_no);
            const source = stateAt(track, action.frame)?.geometry
              ?? (action.frame < track.start_frame ? keys[0] : keys[keys.length - 1])?.geometry;
            if (!source) return;
            await putTrackKey(track.id, action.frame, { geometry: source, extend: true });
            await load();
            setFrame(action.frame);
          });
          break;
        case "hide":
          // Ключи на краях, снос ключей внутри и сам отрезок — одной транзакцией на сервере.
          guard(async () => {
            await hideTrackSpan(track.id, action.from!, action.frame);
            await load();
          });
          break;
        case "menu":
          setLaneMenu(action);
          break;
      }
    },
    [trackById, guard, load, stop, frozen]
  );

  // --- полуавтомат --------------------------------------------------------- #
  const ensureFrame = useCallback(
    async (ref: Record<string, unknown>) => {
      const n = (ref as { frame_no?: number }).frame_no;
      if (n === undefined) return;
      await fetch(videoFrameUrl(taskId, video.id, n), { cache: "reload" });
    },
    [taskId, video.id]
  );

  // Пространство разметки — пиксели источника, даже если показана ступень помельче.
  const auto = useAutoLabel(
    { video_id: video.id, frame_no: frame },
    { video_id: video.id, frame_no: Math.min(lastFrame, frame + 1) },
    ensureFrame,
    video.width && video.height ? { w: video.width, h: video.height } : null,
    code
  );

  const clearAuto = useCallback(() => {
    setAutoPts([]);
    setAutoPrev(null);
  }, []);

  /** Работает ли полуавтомат прямо сейчас: в «выборе» рисовать нечем. */
  const autoLive = autoOn && tool !== "select" && auto.state === "ready";

  const pickAuto = useCallback(() => {
    setAutoOn((v) => {
      if (!v) setTool((t) => (t === "select" ? "box" : t));
      return !v;
    });
    clearAuto();
  }, [clearAuto]);

  useEffect(() => { clearAuto(); }, [frame, clearAuto]);

  const ask = useCallback(
    async (points: CanvasPoint[], prompt: CanvasShape | null) => {
      const shape = await auto.predict(
        { points, box: prompt ? { x: prompt.x, y: prompt.y, w: prompt.w, h: prompt.h } : undefined },
        refine
      );
      if (!shape) { setAutoPrev(null); return; }
      setAutoPrev({ ...shape.box, polygons: shape.polygons, color: labelOf(active ?? 0).color });
    },
    [auto, refine, labelOf, active]
  );

  const commitAuto = useCallback(() => {
    if (!autoPrev || active === null) return;
    const geometry = { x: autoPrev.x, y: autoPrev.y, w: autoPrev.w, h: autoPrev.h };
    const rings = (autoPrev.polygons || []).filter((r) => r.length >= poly.MIN_POINTS) as Ring[];
    const single: SingleWire & { source: "model" } =
      tool === "polygon" && rings.length
        ? { class_index: active, kind: "polygon", parts: rings,
            ...(poly.bounds(rings) || geometry), source: "model" }
        : { class_index: active, ...geometry, source: "model" };
    if (tool !== "track") {
      apply((was) => [...was.shapes, single as CanvasShape]);
      clearAuto();
      return;
    }
    guard(async () => {
      if (currentTrack) {
        await putTrackKey(currentTrack.id, frame, { geometry, source: "model" });
      } else {
        const track = await createTrack(taskId, video.id, {
          class_index: active, frame_no: frame, geometry, source: "model",
        });
        setPickedTrack(track.id);
      }
      await load();
    });
    clearAuto();
  }, [autoPrev, active, currentTrack, tool, frame, guard, load, taskId, video.id, clearAuto, apply]);

  const onAutoPoint = useCallback(
    (p: { x: number; y: number }, o: { shift: boolean; negative: boolean; onBox: number | null }) => {
      if (frozen || active === null || auto.state !== "ready") return;
      if (o.negative) {
        if (!autoPrev) return;
        const pts = [...autoPts, { x: p.x, y: p.y, label: 0 }];
        setAutoPts(pts);
        ask(pts, null);
        return;
      }
      if (o.shift && autoPrev) {
        const pts = [...autoPts, { x: p.x, y: p.y, label: 1 }];
        setAutoPts(pts);
        ask(pts, null);
        return;
      }
      if (autoPrev) {
        const inside =
          p.x >= autoPrev.x && p.x <= autoPrev.x + autoPrev.w &&
          p.y >= autoPrev.y && p.y <= autoPrev.y + autoPrev.h;
        if (inside) return;
        commitAuto();
      }
      const pts = [{ x: p.x, y: p.y, label: 1 }];
      setAutoPts(pts);
      ask(pts, null);
    },
    [frozen, active, auto.state, autoPrev, autoPts, ask, commitAuto]
  );

  const onAutoBox = useCallback(
    (b: { x: number; y: number; w: number; h: number }) => {
      if (frozen || active === null || auto.state !== "ready") return;
      if (autoPrev) commitAuto();
      setAutoPts([]);
      ask([], { class_index: -1, ...b });
    },
    [frozen, active, auto.state, autoPrev, commitAuto, ask]
  );

  // --- объекты ------------------------------------------------------------- #
  /** Одиночная становится треком: тот же класс и рамка, но объект живёт во времени. */
  const toTrack = useCallback(
    (box: VideoSingleBox) => {
      if (box.class_index === null) return;
      guard(async () => {
        const track = await createTrack(taskId, video.id, {
          class_index: box.class_index as number,
          frame_no: box.frame_no,
          geometry: box.geometry as { x: number; y: number; w: number; h: number },
        });
        setPickedTrack(track.id);
        setTool("track");
        await load();
      });
      // Одиночная уходит следом в той же очереди: иначе на кадре два бокса на одном месте.
      editSingle(box, () => null);
    },
    [taskId, video.id, guard, load, editSingle]
  );

  const dropItem = useCallback(
    (item: Item) => {
      if (item.kind === "single") {
        pick(null);
        editSingle(item.box, () => null);
      } else void askDrop(item.track);
    },
    [editSingle, askDrop, pick]
  );

  const recolor = useCallback((i: number, ci: number) => {
    const item = items[i];
    if (!item || frozen) return;
    if (item.kind === "track") patchTrack(item.track, { class_index: ci });
    else editSingle(item.box, (s) => ({ ...s, class_index: ci }));
  }, [items, frozen, patchTrack, editSingle]);

  const pickClass = useCallback(
    (ci: number, target: number | null = tool === "select" ? selected : null) => {
      setActive(ci);
      if (target !== null) recolor(target, ci);
    },
    [tool, selected, recolor]
  );

  // --- закрытие разметки --------------------------------------------------- #
  const finishAnnotation = useCallback(async () => {
    if (!(await settle())) return;
    let p: MaterializePreview;
    try {
      p = await previewMaterialize(taskId, video.id);
    } catch (e) {
      setPlanError(errorText(e));
      return;
    }
    if (p.error) { setPlanError(p.error); return; }
    const ok = await confirm({
      title: "Закрыть разметку ролика?",
      desc: "Разметка станет кадрами таски. Править ролик дальше можно, открыв разметку заново.",
      lines: [
        `${count(p.frames, "кадр", "кадра", "кадров")} ${plural(p.frames, "уйдёт", "уйдут", "уйдут")} в таску${p.empty ? `, из них ${p.empty} ${plural(p.empty, "фоновый", "фоновых", "фоновых")}` : ""}`,
        `${count(p.boxes, "объект", "объекта", "объектов")} на них`,
        ...(p.updated_frames ? [`${count(p.updated_frames, "кадр", "кадра", "кадров")} уже в таске — ${plural(p.updated_frames, "обновится", "обновятся", "обновятся")}`] : []),
      ],
      ok: "Закрыть разметку", icon: "lock",
    });
    if (!ok) return;
    stop();
    setClosing(0);
    try {
      const { job_id } = await closeVideoAnnotation(taskId, video.id);
      const made = await pollJob<{ created: number; boxes: number; empty: number }>(job_id, (j) => {
        setClosing(j.total ? j.processed / j.total : 0);
      });
      setClosedAt(new Date().toISOString());
      setNote(`Разметка закрыта: ${count(made.created, "кадр", "кадра", "кадров")} в таске` +
        (made.empty ? `, из них ${made.empty} ${plural(made.empty, "фоновый", "фоновых", "фоновых")}.` : "."));
      onChanged?.();
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setClosing(null);
    }
  }, [settle, taskId, video.id, confirm, stop, onChanged, load]);

  const reopen = useCallback(async () => {
    try {
      await reopenVideoAnnotation(taskId, video.id);
      setClosedAt(null);
      setNote(null);
      onChanged?.();
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  }, [taskId, video.id, onChanged, load]);

  // --- клавиши ------------------------------------------------------------- #
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (hasLayer()) return;
      if (isTyping(e.target) || ownsArrows(e.target, e.key)) return;
      if (e.key === "?") { setKeysOpen(true); e.preventDefault(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const step = e.shiftKey ? 10 : 1;
      switch (e.code) {
        case "Escape":
          if (autoPrev || autoPts.length) clearAuto();
          else if (tool !== "select") setTool("select");
          else if (selected !== null || pickedTrack) pick(null);
          else void closeEditor();
          break;
        case "Space":
          if (autoPrev) commitAuto();
          else togglePlay();
          break;
        // Enter нативно нажал бы кнопку в фокусе
        case "Enter":
        case "NumpadEnter":
          break;
        case "ArrowRight": go(step); break;
        case "ArrowLeft": go(-step); break;
        case "KeyV": setTool("select"); break;
        case "KeyB": if (!frozen) setTool("box"); break;
        case "KeyP": if (!frozen) setTool("polygon"); break;
        case "KeyT": if (!frozen) setTool("track"); break;
        case "KeyA": if (!frozen && auto.state === "ready") pickAuto(); break;
        case "KeyE": toggleEmpty(); break;
        case "KeyR": if (scout.length) toggleScout(); break;
        case "KeyK": putKey(); break;
        case "Digit0": canvas.current?.fit(); break;
        case "Delete":
        case "Backspace":
          if (selected !== null && !frozen) {
            // Через холст: у трека снимется ключ кадра (последний — с вопросом), одиночные уйдут списком.
            const i = selected;
            apply((was) => was.shapes.filter((_, k) => k !== i));
            if (items[i]?.kind === "single") pick(null);
          } else if (autoPrev || autoPts.length) clearAuto();
          break;
        default: {
          const c = digitClass(classes, e.code);
          if (!c) return;
          pickClass(c.class_index);
        }
      }
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [tool, frozen, autoPrev, autoPts, clearAuto, closeEditor, togglePlay, go, auto.state, pickAuto,
      selected, pickedTrack, pick, apply, items, classes, pickClass, commitAuto, toggleEmpty, putKey,
      scout.length, toggleScout]);

  // --- док ----------------------------------------------------------------- #
  const room = () => body.current?.clientHeight ?? 900;
  const sizeDock = (h: number) => {
    const v = clampDock(h, room());
    dockLive.current = v;
    setDockH(v);
  };

  const covered = useMemo(() => coveredSpans(data?.tracks || [], data?.singles || []), [data]);
  const ticks = useMemo(() => singleTicks(data?.singles || []), [data]);
  const closed = closedAt !== null;
  const editable = !readOnly && !unplayable;
  const autoTitle = auto.state === "ready" ? undefined
    : auto.state === "error" ? `Модель недоступна: ${auto.error || "неизвестная ошибка"}` : "Модель готовится…";
  const problem = error || clip.error || shown.error;
  const saveState = error ? "refused" : busy ? "saving" : "saved";
  const emptyState = markedHere ? (busyHere ? "idle" : "on") : busyHere ? "busy" : "off";

  return (
    <div className="ed ve" role="dialog" aria-modal="true" aria-label="Разметка видео">
      <EditorHead
        onBack={() => void closeEditor()}
        backLabel="К таске (Esc)"
        title={video.file_name}
        sub={<>{taskName} · <span className="ui-mono">{fmtTime(video.duration_ms || 0)}</span> · <span className="ui-mono">{ru(fps)}</span> к/с</>}
        extra={closed ? <Badge tone="var(--st-done)" icon="lock">разметка закрыта</Badge> : undefined}
      >
        {clip.preparing && <PrepareNote clip={clip} />}
        {!clip.preparing && clip.loading && <span className="ve-prep"><i />Читаю ролик…</span>}
        {data?.editable && <SaveNote state={saveState} error={error} />}
        <i className="ed-vsep" />
        {scout.length > 0 && (
          <Button variant="ghost" size="sm" icon="scan" kbd="R" aria-pressed={scoutOn} onClick={toggleScout}
            title={scoutOn ? "Вернуть треки на дорожки" : "Разведка агента по классам вместо треков"}>Разведка</Button>
        )}
        {editable && !closed && (
          <Button variant="ghost" size="sm" icon="bot" className="is-agent" onClick={() => setAgentOpen(true)}
            title="Разметить этот ролик агентом: каждый N-й кадр, где не работал человек">Агент</Button>
        )}
        <Button variant="ghost" size="sm" icon="keyboard" kbd="?" onClick={() => setKeysOpen(true)}>Клавиши</Button>
        {!readOnly && !closed && (
          <Button variant="primary" size="sm" icon={planError ? "alert" : "lock"}
            disabled={!data?.editable || closing !== null || !!planError || !plan || plan.frames === 0}
            title={planError ? `Разметку не закрыть: ${planError}` : !plan || plan.frames === 0
              ? "Закрывать нечего: на ролике нет ни объектов, ни фоновых кадров" : "Превратить разметку в кадры таски"}
            onClick={() => void finishAnnotation()}>
            {closing !== null ? `Закрываю… ${Math.round(closing * 100)} %` : "Закрыть разметку"}
          </Button>
        )}
        {!readOnly && closed && (
          <Button variant="outline" size="sm" icon="unlock" onClick={() => void reopen()}>Открыть заново</Button>
        )}
      </EditorHead>

      {(problem || note || planError || agentRun) && (
        <div className="ed-notes">
          {problem && (
            <Notice tone="error" onClose={error ? () => setError(null) : undefined}>
              {problem}
              {clip.error && !unplayable && (
                // Бэкенд могли перезапустить под рукой — без перезагрузки страницы вместе с несохранённым.
                <Button variant="ghost" size="sm" icon="refresh" onClick={clip.retry}>Повторить</Button>
              )}
            </Notice>
          )}
          {planError && !problem && <Notice tone="warn">Разметку не закрыть: {planError}</Notice>}
          {note && <Notice tone="ok" onClose={() => setNote(null)}>{note}</Notice>}
          {agentRun && <AgentRunBar taskId={taskId} run={agentRun} onRun={setAgentRun} onFinished={load} />}
        </div>
      )}

      <div className="ve-body" ref={body} style={{ ["--dock" as string]: `${dockH}px` }}>
        <div
          className={autoLive && auto.busy ? "ed-main auto-wait" : "ed-main"}
          style={{ ["--pt" as string]: "64px", ["--pr" as string]: `${SIDE_W + 28}px`,
            ["--pb" as string]: autoPrev ? "66px" : "16px", ["--pl" as string]: "16px" }}
        >
          {/* Кадр готовится: гасим картинку и показываем кружок */}
          {shown.pending && (
            <div className="ve-busy" role="status" aria-label="Готовлю кадр"><span /></div>
          )}
          <BoxCanvas
            ref={canvas}
            imageId={`${video.id}:${frame}`}
            bitmap={shown.image}
            fileName={video.file_name}
            width={video.width || 1}
            height={video.height || 1}
            boxes={draft ?? boxes}
            dashed={dashed}
            hiddenItems={hiddenIdx}
            labelOf={labelOf}
            editable={!frozen && !shown.lagging}
            waiting={shown.lagging}
            tool={tool === "select" ? "select" : tool === "polygon" ? "polygon" : "box"}
            auto={autoLive}
            selectedPart={selPart}
            onPolygon={onPolygon}
            autoMode="points"
            autoPoints={autoPts}
            autoPreview={autoPrev}
            activeClass={active}
            selected={selected}
            reserve={56}
            onSelect={(i, part) => pick(i, part ?? null)}
            onBoxes={onBoxes}
            onDrawn={() => setTool("select")}
            onScale={setScale}
            onContext={(i, x, y) => setMenu({ i, x, y })}
            onAutoPoint={onAutoPoint}
            onAutoBox={onAutoBox}
            onAutoCommit={commitAuto}
          />

          {/* Пока кадр догоняет, панель гаснет: рисовать нельзя, и это видно сразу */}
          <Float className={shown.lagging ? "ed-top waiting" : "ed-top"} role="toolbar" label="Инструменты">
            <ToolButton icon="pointer" label="Выбор" k="V" pressed={tool === "select"} onClick={() => setTool("select")} />
            <ToolButton icon="bbox" label="Рамка на кадре" k="B" pressed={tool === "box"} disabled={frozen}
              onClick={() => setTool("box")} />
            <ToolButton icon="poly" label="Контур на кадре" k="P" pressed={tool === "polygon"} disabled={frozen}
              onClick={() => setTool("polygon")} />
            <ToolButton icon="route" label="Трек" k="T" pressed={tool === "track"} disabled={frozen}
              onClick={() => setTool("track")} />
            <i className="ed-vsep" />
            <ToolButton icon="sparkle" label="Полуавтомат SAM2" k="A" pressed={autoOn}
              disabled={frozen || auto.state !== "ready"} warming={auto.state === "starting"}
              title={autoTitle} onClick={pickAuto} />
            <ToolMenu label="Настройки полуавтомата" width={300}>
              <AutoSettings refine={refine} onRefine={setRefine} polygon={tool === "polygon"} error={auto.error} />
            </ToolMenu>
            <i className="ed-vsep" />
            <ClassPicker classes={classes} active={active} disabled={frozen && !classes.length}
              onPick={(ci) => pickClass(ci)}
              onCreate={frozen ? undefined : async (name) => {
                try {
                  const c = await ensureClass(code, name);
                  setClasses((prev) => (prev.some((p) => p.id === c.id) ? prev : [...prev, c]));
                  pickClass(c.class_index);
                } catch (e) {
                  setError(errorText(e));
                }
              }} />
          </Float>

          <div className="ed-plates">
            <AutoStatus state={auto.state} error={auto.error} busy={auto.busy} on={autoOn}
              quiet={frozen} onRetry={auto.retry} onDismiss={() => auto.setError(null)} />
          </div>

          <Float className="fe-side ve-side" label="На этом кадре">
            <HereSide items={items} shapes={boxes} frame={frame} numbers={numbers} labelOf={labelOf}
              classes={classes} selected={selected} hidden={hiddenKeys} frozen={frozen}
              onSelect={(i) => pick(i)} onHide={toggleHidden} onClass={recolor}
              onDelete={(i) => { const it = items[i]; if (it) dropItem(it); }}
              onToTrack={(i) => { const it = items[i]; if (it?.kind === "single") toTrack(it.box); }}
              onPatch={(t, b) => void patchTrack(t, b)} />
          </Float>

          {autoPrev && (
            <Float className="ed-bot" role="toolbar" label="Показанное моделью">
              <AutoBar onCommit={commitAuto} onCancel={clearAuto} />
            </Float>
          )}

          <ZoomChip scale={scale} onZoom={(k) => canvas.current?.zoomBy(k)} onFit={() => canvas.current?.fit()} />
        </div>

        <Grip label="Граница кадра и дорожек" height={dockH} onHeight={sizeDock}
          onDone={() => keep(DOCK_KEY, String(dockLive.current))}
          onReset={() => { sizeDock(DOCK_DEFAULT); keep(DOCK_KEY, String(DOCK_DEFAULT)); }} />

        <div className="ve-dock">
          <Transport frame={frame} lastFrame={lastFrame} fps={fps} playing={playing} pending={shown.pending}
            speed={speed} quality={quality} qualities={clip.manifest?.qualities || []} empty={emptyState}
            frozen={frozen} canKey={!!currentTrack && !!stateAt(currentTrack, frame)}
            onGo={go} onPlay={togglePlay} onSpeed={(v) => changeSpeed(v, frame)} onQuality={setQuality}
            onEmpty={toggleEmpty} onKey={putKey} />
          <Lanes tracks={data?.tracks || []} numbers={numbers} frame={frame} lastFrame={lastFrame} fps={fps}
            labelOf={labelOf} selected={pickedTrack} editable={!frozen} hidden={hiddenTracks}
            covered={covered} marks={marks} plan={plan ? plan.frames : null} singles={ticks}
            scout={scout} scoutOpen={scoutOn && scout.length > 0} onScout={toggleScout}
            onSelect={selectTrack} onHide={(id) => toggleHidden(`t:${id}`)} onAction={onLane} onSeek={seek} />
        </div>
      </div>

      <KeysDialog open={keysOpen} onOpenChange={setKeysOpen} groups={KEYS} />
      {confirmNode}

      {agentOpen && (
        <AgentRunDialog taskId={taskId} initial={{ mode: "annotate", videos: [video.id] }}
          onClose={() => setAgentOpen(false)}
          onStarted={(run) => { setAgentOpen(false); setAgentRun(run); }} />
      )}

      {menu && (
        <ClassMenu
          classes={classes}
          at={{ x: menu.x, y: menu.y }}
          current={menu.i === null ? active : boxes[menu.i]?.class_index ?? null}
          onPick={(ci) => {
            if (menu.i === null) setActive(ci);
            else recolor(menu.i, ci);
            setMenu(null);
          }}
          deleteLabel={menu.i !== null && items[menu.i]?.kind === "track" ? "трек целиком" : "объект"}
          onDelete={
            menu.i === null || !items[menu.i] || frozen
              ? undefined
              : () => {
                  dropItem(items[menu.i as number]);
                  setMenu(null);
                }
          }
          actions={
            menu.i !== null && items[menu.i]?.kind === "single" && !frozen
              ? [
                  (() => {
                    const item = items[menu.i as number];
                    // Трек ведут рамкой: пункт для контура остаётся с причиной, а не исчезает.
                    const contour = item.kind === "single" && item.box.shape?.kind === "polygon";
                    return {
                      label: "Сделать треком",
                      hint: contour ? "контуром нельзя: трек ведут рамкой" : "объект начнёт жить во времени",
                      disabled: contour,
                      run: () => {
                        if (item.kind === "single" && !contour) toTrack(item.box);
                        setMenu(null);
                      },
                    };
                  })(),
                ]
              : undefined
          }
          onClose={() => setMenu(null)}
        />
      )}

      {laneMenu && (
        <LaneMenu
          action={laneMenu}
          track={trackById(laneMenu.trackId)}
          frozen={frozen}
          onClose={() => setLaneMenu(null)}
          onKey={() => guard(async () => {
            await putTrackKey(laneMenu.trackId, laneMenu.frame, {});
            await load();
          })}
          onDropKey={() => guard(async () => {
            await deleteTrackKey(laneMenu.trackId, laneMenu.frame);
            await load();
          })}
          onHide={(to) => guard(async () => {
            await hideTrackSpan(laneMenu.trackId, laneMenu.frame, to);
            await load();
          })}
          onShow={() => {
            const { trackId, frame: from } = laneMenu;
            // Снимаем ровно ту зону, что держит этот ключ; список — в момент отправки.
            guard(async () => {
              const track = (dataNow.current?.tracks || []).find((t) => t.id === trackId);
              if (!track) return;
              await updateTrack(track.id, {
                hidden_ranges: (track.hidden_ranges || []).filter(([f]) => f !== from),
              });
              await load();
            });
          }}
          onDrop={() => { const t = trackById(laneMenu.trackId); if (t) void askDrop(t); }}
        />
      )}
    </div>
  );
}

/** Фигура холста — одиночной разметкой для сервера. Контур помечается контуром. */
function wireOf(box: CanvasShape, id?: string): SingleWire {
  const { class_index, ...rest } = box;
  return {
    ...rest,
    ...(rest.parts?.length ? { kind: "polygon" as const } : {}),
    id: id ?? rest.id,
    class_index,
  } as SingleWire;
}

/** Одна ли это фигура — по тому, что человек мог подвинуть: у контура сравниваются точки, а не рамка. */
function same(a: CanvasShape | undefined, b: CanvasShape | undefined): boolean {
  if (!a || !b) return false;
  if (a.class_index !== b.class_index) return false;
  if (a.parts || b.parts) {
    return JSON.stringify(a.parts ?? null) === JSON.stringify(b.parts ?? null);
  }
  return (
    Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 &&
    Math.abs(a.w - b.w) < 0.01 && Math.abs(a.h - b.h) < 0.01
  );
}

function trackName(track: VideoTrack, labelOf: (ci: number) => { name: string }): string {
  return track.label || labelOf(track.class_index ?? -1).name || "объект";
}
