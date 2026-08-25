import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createClass,
  createTrack,
  deleteTrack,
  deleteTrackKey,
  getClasses,
  getVideoAnnotations,
  moveTrackKey,
  previewMaterialize,
  putTrackKey,
  saveFrameBoxes,
  updateTrack,
  videoFrameUrl,
} from "../../auth/api";
import type {
  AutoRefine,
  LabelClass,
  TaskVideoItem,
  VideoAnnotations,
  VideoSingleBox,
  VideoTrack,
} from "../../auth/api";
import BoxCanvas from "./BoxCanvas";
import type { CanvasBox, CanvasHandle, CanvasPoint, CanvasPreview } from "./BoxCanvas";
import ClassMenu from "./ClassMenu";
import TrackLanes from "./TrackLanes";
import type { LaneAction } from "./TrackLanes";
import { useAutoLabel } from "./useAutoLabel";
import { useClip, useClipFrame, usePlayback } from "./useClip";
import type { Clip } from "./useClip";
import {
  exportCount,
  fmtFrameTime,
  frameToMs,
  keyAt,
  msToFrame,
  normalizeRanges,
  stateAt,
} from "./trackMath";

/** Управление редактором: клавиша и что она делает.
 *
 * Один список на две задачи — подсветку самого элемента и панель со всеми
 * сочетаниями. Держать их порознь значило бы, что однажды они разойдутся, и
 * подсказка начнёт врать про клавишу.
 */
const HELP = {
  close: ["Esc", "Выйти из разметки"],
  select: ["V", "Выбор и правка"],
  box: ["B", "Бокс на этом кадре"],
  track: ["T", "Трек-бокс: объект, живущий во времени"],
  auto: ["A", "Полуавтомат: обвести объект по клику"],
  zoomIn: ["", "Приблизить"],
  zoomOut: ["", "Отдалить"],
  fit: ["0", "Вписать кадр в окно"],
  play: ["Пробел", "Играть или остановить"],
  prev: ["←", "Кадр назад"],
  next: ["→", "Кадр вперёд"],
  speed: ["", "Скорость просмотра. Быстрее единицы — через кадр"],
  quality: ["", "Качество картинки: исходное или помельче"],
  scrub: ["", "Перемотка по ролику"],
  key: ["K", "Поставить ключ трека на этом кадре"],
  occlude: ["Alt + протяжка", "Заслонить участок на дорожке объекта"],
  lane: ["", "Дорожка объекта: ромб — ключ, края — жизнь трека"],
  cls: ["", "Класс для новых объектов"],
} as const;

type HelpId = keyof typeof HELP;

/** Разметить элемент для справки: подсветится и покажет свою подсказку. */
function hk(id: HelpId) {
  const [key, text] = HELP[id];
  return { "data-hk": key || undefined, "data-ht": text, "data-help": "" };
}

const GREY = { name: "", color: "#9aa4ae" };

/** Что говорят человеку, пока ролик готовится.
 *
 * Названия работ — внутренние, и показывать их как есть нельзя: разметчику
 * нечего делать со словом «chunkset». Ему нужно знать, что происходит и
 * сколько осталось.
 */
const STAGE_TEXT: Record<string, string> = {
  index: "Разбираю ролик на кадры",
  strip: "Клею киноленту",
  variant: "Готовлю ступень качества",
  chunkset: "Нарезаю ролик на куски",
  chunk: "Готовлю этот кусок",
};

/** Полоса подготовки ролика.
 *
 * Раньше на её месте была мигающая точка: тяжёлая работа шла на сервере, и
 * узнать про неё было неоткуда. Теперь воркер отчитывается, куда дошёл, и
 * ожидание перестаёт выглядеть как поломка.
 */
function PrepareNote({ clip }: { clip: Clip }) {
  const stage = clip.progress?.kind || clip.preparing?.stage || "index";
  const text = STAGE_TEXT[stage] || "Готовлю видео";
  const total = clip.progress?.total || 0;
  const done = clip.progress?.processed || 0;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
  return (
    <span className="mag-ved-prepare">
      <i className="mag-ved-prepare-dot" />
      {text}
      {percent !== null && <b>{percent}%</b>}
    </span>
  );
}

/** Что стоит за боксом на холсте: трек или одиночный бокс этого кадра. */
type Item =
  | { kind: "track"; track: VideoTrack; hidden: boolean }
  | { kind: "single"; box: VideoSingleBox };

/**
 * Редактор размечаемого видео.
 *
 * Кадр всегда серверный — тот же, что уйдёт в датасет. Браузерного плеера
 * здесь нет вовсе: currentTime не даёт номера кадра, и рисовать по нему значило
 * бы разметить не тот кадр, который выгрузится. Быстрая перемотка держится на
 * прогреве окна кадров одним проходом декодера.
 *
 * Время объектов живёт внизу, под кадром: дорожки всех треков разом показывают,
 * кто когда появляется, где они пересекаются и где кто заслонён.
 */
export default function VideoAnnotator({
  code,
  taskId,
  taskName,
  video,
  readOnly,
  onClose,
}: {
  code: string;
  taskId: string;
  taskName: string;
  video: TaskVideoItem;
  readOnly: boolean;
  onClose: () => void;
}) {
  const fps = video.fps || 25;

  // Ролик приезжает перегонами, и число кадров берётся из его таблицы кадров,
  // а не из прикидки по длительности: разметка адресуется номером кадра, и
  // «примерно столько» тут не годится.
  const clip = useClip(taskId, video.id);
  const lastFrame = Math.max(
    0,
    (clip.manifest?.frame_count ?? video.frame_count ?? msToFrame(video.duration_ms || 0, fps)) - 1
  );

  const [data, setData] = useState<VideoAnnotations | null>(null);
  const [classes, setClasses] = useState<LabelClass[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [frame, setFrame] = useState(0);
  const [tool, setTool] = useState<"select" | "box" | "track" | "auto">("select");
  const [selected, setSelected] = useState<number | null>(null);
  const [pickedTrack, setPickedTrack] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ frames: number; boxes: number } | null>(null);
  const [menu, setMenu] = useState<{ i: number | null; x: number; y: number } | null>(null);
  const [laneMenu, setLaneMenu] = useState<LaneAction | null>(null);
  const [scale, setScale] = useState(1);
  const [draft, setDraft] = useState<CanvasBox[] | null>(null);

  const [autoPts, setAutoPts] = useState<CanvasPoint[]>([]);
  const [autoPrev, setAutoPrev] = useState<CanvasPreview | null>(null);
  // Параметры полуавтомата пока не настраиваются из видеоредактора: панель
  // жила в правой колонке, которой больше нет. Значения те же, что по
  // умолчанию в редакторе кадров.
  const [refine] = useState<AutoRefine>({
    detail: "auto", score_min: 0.3, min_area: 64, fill_holes: true, polygon_points: 64,
  });

  const canvas = useRef<CanvasHandle>(null);
  const draftTimer = useRef<number>();

  const frozen = readOnly || !data?.editable;

  // --- кадры и проигрывание ------------------------------------------------ #
  // Ступень качества: исходное или уменьшенное. Хранится здесь, а не в
  // читателе, чтобы её видел и хук, и кнопка выбора.
  const [quality, setQuality] = useState<string>("");
  const [qualityOpen, setQualityOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [objectsOpen, setObjectsOpen] = useState(false);

  useEffect(() => {
    if (clip.manifest && !quality) setQuality(clip.manifest.quality);
  }, [clip.manifest, quality]);
  const shown = useClipFrame(clip.reader, frame, quality);
  const onPlayFrame = useCallback((f: number) => setFrame(f), []);
  // Проигрывание ждёт картинку: пока показан не тот кадр, время стоит. Иначе
  // полоса убегает вперёд, кадр замирает, и кусок ролика проходит незамеченным.
  const behind = useRef(false);
  behind.current = shown.lagging;
  const caughtUp = useCallback(() => !behind.current, []);
  const { playing, speed, start, stop, changeSpeed } = usePlayback(
    fps, lastFrame, onPlayFrame, caughtUp
  );

  // --- загрузка ------------------------------------------------------------ #
  const load = useCallback(async () => {
    try {
      setData(await getVideoAnnotations(taskId, video.id));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [taskId, video.id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    getClasses(code)
      .then((c) => {
        setClasses(c.classes);
        setActive((prev) => prev ?? (c.classes[0]?.class_index ?? null));
      })
      .catch(() => {});
  }, [code]);

  useEffect(() => {
    if (!data) return;
    const h = window.setTimeout(() => {
      previewMaterialize(taskId, video.id)
        .then((p) => setPlan({ frames: p.frames, boxes: p.boxes }))
        .catch(() => setPlan(null));
    }, 500);
    return () => window.clearTimeout(h);
  }, [data, taskId, video.id]);

  const byIndex = useMemo(() => {
    const m = new Map<number, LabelClass>();
    classes.forEach((c) => m.set(c.class_index, c));
    return m;
  }, [classes]);

  const labelOf = useCallback((ci: number) => byIndex.get(ci) || GREY, [byIndex]);

  const visibleClasses = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return classes;
    return classes.filter(
      (c) => c.name.toLowerCase().includes(q) || String(c.class_index) === q
    );
  }, [classes, query]);

  // --- что показано на кадре ----------------------------------------------- #
  const { items, boxes, dashed } = useMemo(() => {
    const its: Item[] = [];
    const bs: CanvasBox[] = [];
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
      bs.push({ class_index: single.class_index, ...single.geometry });
    }
    return { items: its, boxes: bs, dashed: dim };
  }, [data, frame]);

  const singlesHere = useMemo(
    () => (data?.singles || []).filter((s) => s.frame_no === frame),
    [data, frame]
  );

  const currentTrack = useMemo(
    () => (data?.tracks || []).find((t) => t.id === pickedTrack) || null,
    [data, pickedTrack]
  );

  const trackById = useCallback(
    (id: string) => (data?.tracks || []).find((t) => t.id === id) || null,
    [data]
  );

  // --- сохранение ---------------------------------------------------------- #
  const guard = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const saveSingles = useCallback(
    (list: { class_index: number; x: number; y: number; w: number; h: number }[]) =>
      guard(async () => {
        await saveFrameBoxes(taskId, video.id, frame, list);
        await load();
      }),
    [guard, taskId, video.id, frame, load]
  );

  const singlesAsList = useCallback(
    () => singlesHere.map((s) => ({ class_index: s.class_index as number, ...s.geometry })),
    [singlesHere]
  );

  const commit = useCallback(
    (next: CanvasBox[]) => {
      if (frozen || active === null) return;

      if (next.length > boxes.length) {
        const fresh = next[next.length - 1];
        if (tool === "track") {
          guard(async () => {
            const track = await createTrack(taskId, video.id, {
              class_index: fresh.class_index,
              frame_no: frame,
              geometry: { x: fresh.x, y: fresh.y, w: fresh.w, h: fresh.h },
            });
            setPickedTrack(track.id);
            await load();
          });
        } else {
          saveSingles([...singlesAsList(), fresh]);
        }
        return;
      }

      if (next.length < boxes.length) {
        const gone = items[boxes.findIndex((b, i) => !same(b, next[i]))] ?? items[items.length - 1];
        if (!gone) return;
        if (gone.kind === "track") removeTrackBox(gone.track);
        else saveSingles(singlesHere.filter((s) => s.id !== gone.box.id)
          .map((s) => ({ class_index: s.class_index as number, ...s.geometry })));
        return;
      }

      const idx = next.findIndex((b, i) => !same(b, boxes[i]));
      if (idx < 0) return;
      const item = items[idx];
      const box = next[idx];
      if (item.kind === "track") {
        // Правка положения на кадре и есть постановка ключа: разметчик сказал
        // «здесь объект вот так», и с этого кадра счёт идёт от него.
        guard(async () => {
          await putTrackKey(item.track.id, frame, {
            geometry: { x: box.x, y: box.y, w: box.w, h: box.h },
          });
          await load();
        });
      } else {
        saveSingles(
          singlesHere.map((s) =>
            s.id === item.box.id
              ? { class_index: box.class_index, x: box.x, y: box.y, w: box.w, h: box.h }
              : { class_index: s.class_index as number, ...s.geometry }
          )
        );
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [frozen, active, boxes, items, tool, frame, guard, taskId, video.id, load,
     saveSingles, singlesHere, singlesAsList]
  );

  /** Пока тянут рамку, холст сообщает о каждом её положении — начиная с
   *  нулевой на нажатии. Отправляем осевшее. */
  const onBoxes = useCallback(
    (next: CanvasBox[]) => {
      setDraft(next);
      window.clearTimeout(draftTimer.current);
      draftTimer.current = window.setTimeout(() => commit(next), 350);
    },
    [commit]
  );

  useEffect(() => {
    setDraft(null);
    window.clearTimeout(draftTimer.current);
  }, [frame, video.id]);

  useEffect(() => { setDraft(null); }, [data]);

  const removeTrackBox = useCallback(
    (track: VideoTrack) => {
      if (track.keys.length <= 1 || !keyAt(track, frame)) {
        if (!window.confirm(`Удалить объект «${trackName(track, labelOf)}» целиком?`)) return;
        guard(async () => {
          await deleteTrack(track.id);
          setPickedTrack(null);
          await load();
        });
        return;
      }
      guard(async () => {
        await deleteTrackKey(track.id, frame);
        await load();
      });
    },
    [frame, guard, load, labelOf]
  );

  const patchTrack = useCallback(
    (track: VideoTrack, body: Parameters<typeof updateTrack>[1]) =>
      guard(async () => {
        await updateTrack(track.id, body);
        await load();
      }),
    [guard, load]
  );

  // --- действия с дорожек -------------------------------------------------- #
  const onLane = useCallback(
    (action: LaneAction) => {
      const track = trackById(action.trackId);
      if (!track) return;
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
        case "set-start":
          // Начало трека — его первый ключ, поэтому двигаем именно ключ.
          guard(async () => {
            await moveTrackKey(track.id, track.start_frame, action.frame);
            await load();
          });
          break;
        case "set-end":
          patchTrack(track, { end_frame: action.frame });
          break;
        case "hide":
          patchTrack(track, {
            hidden_ranges: normalizeRanges([
              ...(track.hidden_ranges || []),
              [action.from!, action.frame],
            ]),
          });
          break;
        case "menu":
          setLaneMenu(action);
          break;
      }
    },
    [trackById, guard, load, patchTrack]
  );

  // --- навигация ----------------------------------------------------------- #
  const go = useCallback(
    (delta: number) => {
      stop();
      setFrame((f) => Math.max(0, Math.min(lastFrame, f + delta)));
      setSelected(null);
    },
    [lastFrame, stop]
  );

  const togglePlay = useCallback(() => {
    if (playing) stop();
    else start(frame >= lastFrame ? 0 : frame);
  }, [playing, stop, start, frame, lastFrame]);

  // --- полуавтомат --------------------------------------------------------- #
  const ensureFrame = useCallback(
    async (ref: Record<string, unknown>) => {
      const n = (ref as { frame_no?: number }).frame_no;
      if (n === undefined) return;
      await fetch(videoFrameUrl(taskId, video.id, n), { cache: "reload" });
    },
    [taskId, video.id]
  );

  // Пространство разметки — пиксели источника. Канва считает координаты от
  // размеров ролика, а показывать может ступень качества, которая мельче;
  // сервер распаковывает кадр для полуавтомата в тех же размерах источника, но
  // знать об этом клиенту незачем — он просто говорит, в чём считает.
  const auto = useAutoLabel(
    { video_id: video.id, frame_no: frame },
    { video_id: video.id, frame_no: Math.min(lastFrame, frame + 1) },
    ensureFrame,
    video.width && video.height ? { w: video.width, h: video.height } : null
  );

  const clearAuto = useCallback(() => {
    setAutoPts([]);
    setAutoPrev(null);
  }, []);

  useEffect(() => { clearAuto(); }, [frame, clearAuto]);

  const ask = useCallback(
    async (points: CanvasPoint[], prompt: CanvasBox | null) => {
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
    guard(async () => {
      if (currentTrack && tool === "track") {
        await putTrackKey(currentTrack.id, frame, { geometry, source: "model" });
      } else if (tool === "track") {
        const track = await createTrack(taskId, video.id, {
          class_index: active, frame_no: frame, geometry, source: "model",
        });
        setPickedTrack(track.id);
      } else {
        await saveFrameBoxes(taskId, video.id, frame, [
          ...singlesAsList(), { class_index: active, ...geometry },
        ]);
      }
      await load();
    });
    clearAuto();
  }, [autoPrev, active, currentTrack, tool, frame, guard, load, taskId, video.id,
      clearAuto, singlesAsList]);

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

  // --- клавиши ------------------------------------------------------------- #
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const step = e.shiftKey ? 10 : 1;
      switch (e.code) {
        case "Escape":
          if (autoPrev || autoPts.length) clearAuto();
          else if (laneMenu) setLaneMenu(null);
          else if (tool !== "select") setTool("select");
          else onClose();
          break;
        case "Space":
          if (autoPrev) commitAuto();
          else togglePlay();
          break;
        case "ArrowRight": go(step); break;
        case "ArrowLeft": go(-step); break;
        case "KeyV": setTool("select"); break;
        case "KeyB": if (!frozen) setTool("box"); break;
        case "KeyT": if (!frozen) setTool("track"); break;
        case "KeyA": if (!frozen && auto.state === "ready") setTool("auto"); break;
        case "KeyK":
          if (!frozen && currentTrack) {
            guard(async () => { await putTrackKey(currentTrack.id, frame, {}); await load(); });
          }
          break;
        case "Digit0": canvas.current?.fit(); break;
        case "Delete":
        case "Backspace":
          if (selected !== null && !frozen) {
            const item = items[selected];
            if (item?.kind === "track") removeTrackBox(item.track);
            else if (item) {
              saveSingles(singlesHere.filter((s) => s.id !== item.box.id)
                .map((s) => ({ class_index: s.class_index as number, ...s.geometry })));
            }
            setSelected(null);
          } else if (autoPrev || autoPts.length) clearAuto();
          break;
        default: {
          const digit = /^Digit([1-9])$/.exec(e.code);
          if (!digit) return;
          const c = visibleClasses[Number(digit[1]) - 1];
          if (c) setActive(c.class_index);
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
  }, [tool, frozen, autoPrev, autoPts, clearAuto, onClose, togglePlay, go, auto.state,
      currentTrack, selected, items, removeTrackBox, saveSingles, singlesHere,
      visibleClasses, commitAuto, frame, guard, load, laneMenu]);

  useEffect(() => {
    if (selected === null) return;
    const item = items[selected];
    if (item?.kind === "track") setPickedTrack(item.track.id);
  }, [selected, items]);


  /** Превратить одиночный бокс в трек: тот же класс и та же рамка, но объект
   *  начинает жить во времени. Нужно постоянно — разметчик обводит объект,
   *  видит, что тот едет дальше, и хочет вести его, а не обводить заново. */
  const toTrack = useCallback(
    (box: VideoSingleBox) => {
      if (box.class_index === null) return;
      guard(async () => {
        const track = await createTrack(taskId, video.id, {
          class_index: box.class_index as number,
          frame_no: box.frame_no,
          geometry: box.geometry,
        });
        setPickedTrack(track.id);
        setTool("track");
        // Одиночный уходит: иначе на кадре осталось бы два бокса на одном месте.
        await saveFrameBoxes(
          taskId,
          video.id,
          box.frame_no,
          (data?.singles || [])
            .filter((s) => s.frame_no === box.frame_no && s.id !== box.id)
            .map((s) => ({ class_index: s.class_index as number, ...s.geometry }))
        );
        await load();
      });
    },
    [taskId, video.id, data, guard, load]
  );

  const dropItem = useCallback(
    (item: Item) => {
      guard(async () => {
        if (item.kind === "track") {
          await deleteTrack(item.track.id);
          setPickedTrack(null);
        } else {
          await saveFrameBoxes(
            taskId,
            video.id,
            item.box.frame_no,
            (data?.singles || [])
              .filter((s) => s.frame_no === item.box.frame_no && s.id !== item.box.id)
              .map((s) => ({ class_index: s.class_index as number, ...s.geometry }))
          );
        }
        setSelected(null);
        await load();
      });
    },
    [taskId, video.id, data, guard, load]
  );

  /** Одиночные объекты по классам: на каких кадрах они есть.
   *
   *  У трека время видно на дорожке, а одиночный бокс живёт на своём кадре и
   *  из общей картины выпадает: разметчик не помнит, где уже обвёл, а где нет.
   *  Поэтому — отдельный свод, по классам и с номерами кадров.
   */
  const singleFrames = useMemo(() => {
    const by = new Map<number, number[]>();
    for (const single of data?.singles || []) {
      if (single.class_index === null) continue;
      const list = by.get(single.class_index) || [];
      list.push(single.frame_no);
      by.set(single.class_index, list);
    }
    return [...by.entries()]
      .map(([ci, frames]) => ({ ci, frames: [...new Set(frames)].sort((a, b) => a - b) }))
      .sort((a, b) => b.frames.length - a.frames.length);
  }, [data]);

  const timeMs = frameToMs(frame, fps);
  const closed = video.annotation_closed_at !== null;

  return (
    <div
      className={help ? "mag-ed mag-ved help" : "mag-ed mag-ved"}
      role="dialog"
      aria-modal="true"
      aria-label="Разметка видео"
    >
      <div className="mag-ed-head">
        <b>{taskName}</b>
        <span className="mag-ed-cnt">
          кадр {String(frame).padStart(String(lastFrame).length, " ")} / {lastFrame}
          {" · "}
          {fmtFrameTime(timeMs)}
        </span>
        {active !== null && (
          <button type="button"
            className={tool === "auto" ? "mag-ed-active on" : "mag-ed-active"}
            {...hk("cls")}
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMenu({ i: null, x: r.left, y: r.bottom + 6 });
            }}>
            <i style={{ background: labelOf(active).color }} />
            {labelOf(active).name || active}
            <b>▾</b>
          </button>
        )}
        {closed && <span className="mag-ed-flag nul">разметка закрыта</span>}
        <span className="mag-ed-sp" />
        {(error || clip.error || shown.error) && (
          <span className="mag-ed-err">
            {error || clip.error || shown.error}
            {clip.error && (
              // Бэкенд могли перезапустить под рукой. Раньше единственным
              // выходом была перезагрузка страницы — вместе с несохранённым.
              <button type="button" className="mag-ed-retry" onClick={clip.retry}>
                Повторить
              </button>
            )}
          </span>
        )}
        {clip.preparing && <PrepareNote clip={clip} />}
        {!clip.preparing && clip.loading && (
          <span className="mag-ed-note">Читаю ролик…</span>
        )}
        {plan && (
          <span className="mag-ved-plan">
            в таску: <b>{plan.frames}</b> кадров · {plan.boxes} объектов
          </span>
        )}
        <span className={busy ? "mag-ed-saving" : "mag-ed-saved"}>
          {busy ? "сохраняю…" : "сохранено"}
        </span>
        <button
          className={objectsOpen ? "mag-ed-btn on" : "mag-ed-btn"}
          type="button"
          onClick={() => setObjectsOpen((v) => !v)}
          aria-pressed={objectsOpen}
        >
          объекты
        </button>
        <button
          className={help ? "mag-ed-btn on" : "mag-ed-btn"}
          type="button"
          onClick={() => setHelp((v) => !v)}
          aria-pressed={help}
        >
          справка
        </button>
        <button className="mag-ed-btn" type="button" onClick={onClose}
          aria-label="Закрыть" {...hk("close")}>✕</button>
      </div>

      {/* Справка: гасим всё, оставляя светиться органы управления. Подсказки
          по наведению вместо вечных всплывашек — они мешали работать. */}
      {help && (
        <>
          <div className="mag-ed-dim" onClick={() => setHelp(false)} />
          <div className="mag-ed-help">
            <b>Управление</b>
            <div className="mag-ed-help-list">
              {Object.entries(HELP)
                .filter(([, [key]]) => key)
                .map(([id, [key, text]]) => (
                  <div key={id}>
                    <kbd>{key}</kbd>
                    <span>{text}</span>
                  </div>
                ))}
            </div>
            <p>
              Наведите на любую кнопку — покажет, что она делает. Щелчок мимо
              закрывает справку.
            </p>
          </div>
        </>
      )}

      {objectsOpen && (
        <div className="mag-ed-objects">
          <div className="mag-ed-objects-h">
            <b>Одиночные объекты</b>
            <button type="button" onClick={() => setObjectsOpen(false)} aria-label="Закрыть">
              ✕
            </button>
          </div>
          {singleFrames.length === 0 ? (
            <p className="mag-ed-objects-empty">
              Одиночных объектов нет. Обведённое обычным боксом живёт на своём
              кадре и появится здесь.
            </p>
          ) : (
            <div className="mag-ed-objects-list">
              {singleFrames.map(({ ci, frames }) => (
                <div key={ci}>
                  <span className="mag-ed-objects-cls">
                    <i style={{ background: labelOf(ci).color }} />
                    {labelOf(ci).name || ci}
                    <em>{frames.length}</em>
                  </span>
                  <span className="mag-ed-objects-frames">
                    {frames.map((f) => (
                      <button
                        key={f}
                        type="button"
                        className={f === frame ? "on" : undefined}
                        onClick={() => {
                          stop();
                          setFrame(f);
                        }}
                      >
                        {f}
                      </button>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mag-ed-body">
        {/* Пока картинка догоняет, подсветка инструмента гаснет: рисовать
            нельзя, и это должно быть видно, а не выясняться протяжкой. */}
        <div className={shown.lagging ? "mag-ed-rail waiting" : "mag-ed-rail"}>
          <button className={tool === "select" ? "mag-tool on" : "mag-tool"} type="button"
            onClick={() => setTool("select")} {...hk("select")}>↖</button>
          <button className={tool === "box" ? "mag-tool on" : "mag-tool"} type="button"
            disabled={frozen} onClick={() => setTool("box")}
            {...hk("box")}>▢</button>
          <button className={tool === "track" ? "mag-tool on" : "mag-tool"} type="button"
            disabled={frozen} onClick={() => setTool("track")}
            {...hk("track")}>◇</button>
          <button
            className={(tool === "auto" ? "mag-tool on" : "mag-tool") +
              (auto.state === "starting" ? " warming" : "")}
            type="button" disabled={frozen || auto.state !== "ready"}
            onClick={() => { setTool("auto"); clearAuto(); }}
            {...hk("auto")}
            data-ht={
              auto.state === "ready"
                ? HELP.auto[1]
                : "Полуавтомат: модель ещё готовится"
            }>✨</button>
          <hr />
          <button className="mag-tool" type="button" {...hk("zoomIn")}
            onClick={() => canvas.current?.zoomBy(1.3)}>+</button>
          <button className="mag-tool" type="button" {...hk("zoomOut")}
            onClick={() => canvas.current?.zoomBy(1 / 1.3)}>−</button>
          <button className="mag-tool wide" type="button" {...hk("fit")}
            onClick={() => canvas.current?.fit()}>{Math.round(scale * 100)}%</button>
        </div>

        {/* Объекты: только свойства и статистика. Действия переехали на
            дорожки — там, где у объекта есть время. */}
        <aside className="mag-ved-side">
          <h5>Класс</h5>
          <input className="mag-ed-search" type="text" value={query}
            placeholder="Поиск класса…" onChange={(e) => setQuery(e.target.value)} />
          <div className="mag-ved-classes">
            {visibleClasses.map((c, i) => (
              <button key={c.id} type="button"
                className={c.class_index === active ? "mag-ed-cls on" : "mag-ed-cls"}
                onClick={() => setActive(c.class_index)}>
                <i style={{ background: c.color }} />
                <span className="mag-ed-cls-name">{c.name}</span>
                {i < 9 && <kbd>{i + 1}</kbd>}
              </button>
            ))}
          </div>
          {query.trim() && visibleClasses.length === 0 && !frozen && (
            <button className="mag-ed-newcls" type="button"
              onClick={() => {
                createClass(code, { name: query.trim() })
                  .then((c) => {
                    setClasses((prev) => [...prev, c]);
                    setActive(c.class_index);
                    setQuery("");
                  })
                  .catch((e) => setError((e as Error).message));
              }}>
              Ничего не нашлось — создать «{query.trim()}»
            </button>
          )}

          <h5>Объекты · {(data?.tracks || []).length}</h5>
          <div className="mag-ved-objs">
            {(data?.tracks || []).length === 0 ? (
              <p className="mag-ed-hint">
                Нажмите T и обведите объект — он появится дорожкой внизу.
              </p>
            ) : (
              (data?.tracks || []).map((track) => {
                const label = labelOf(track.class_index ?? -1);
                const on = track.id === pickedTrack;
                return (
                  <div key={track.id} className={on ? "mag-ved-obj on" : "mag-ved-obj"}
                    onClick={() => setPickedTrack(track.id)}>
                    <div className="mag-ved-obj-head">
                      <i style={{ background: label.color }} />
                      <span className="mag-ved-obj-name">
                        {track.label || label.name || "объект"}
                      </span>
                      <span className="mag-ved-obj-n">{exportCount(track)} кадров</span>
                    </div>
                    <label className="mag-ved-row">
                      <span>Интерполяция</span>
                      <input type="checkbox" checked={track.interpolate} disabled={frozen}
                        onChange={(e) => patchTrack(track, { interpolate: e.target.checked })} />
                    </label>
                    <label className="mag-ved-row">
                      <span>Шаг выгрузки</span>
                      <input type="number" min={1} value={track.export_step} disabled={frozen}
                        onChange={(e) =>
                          patchTrack(track, { export_step: Math.max(1, Number(e.target.value)) })
                        } />
                    </label>
                    <p className="mag-ved-note">
                      {track.keys.length} ключей · кадры {track.start_frame}—
                      {track.end_frame ?? "…"}
                    </p>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        <div className="mag-ved-stage">
          {/* Кадр готовится: гасим картинку и показываем кружок. Показывать
              проценты нечего — ждать приходится то сеть, то декодер, и число
              всё равно ничего не говорит о том, сколько осталось. */}
          {shown.pending && (
            <div className="mag-ved-busy" role="status" aria-label="Готовлю кадр">
              <span className="mag-ved-spin" />
            </div>
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
            labelOf={labelOf}
            editable={!frozen && !shown.lagging}
            waiting={shown.lagging}
            tool={tool === "track" ? "box" : tool}
            autoMode="points"
            autoPoints={autoPts}
            autoPreview={autoPrev}
            activeClass={active}
            selected={selected}
            reserve={280}
            onSelect={setSelected}
            onBoxes={onBoxes}
            onDrawn={() => setTool("select")}
            onScale={setScale}
            onContext={(i, x, y) => setMenu({ i, x, y })}
            onAutoPoint={onAutoPoint}
            onAutoBox={onAutoBox}
            onAutoCommit={commitAuto}
          />
        </div>

        {autoPrev && (
          <div className="mag-auto-bar">
            <button className="mag-auto-ok" type="button" onClick={commitAuto}>
              Закрепить <kbd>Пробел</kbd>
            </button>
            <button className="mag-auto-no" type="button" onClick={clearAuto}>
              Отменить <kbd>Esc</kbd>
            </button>
          </div>
        )}
      </div>

      {/* Транспорт и время объектов */}
      <div className="mag-ved-bottom">
        <div className="mag-ved-transport">
          <button className="mag-ed-btn" type="button" onClick={togglePlay}
            {...hk("play")}>{playing ? "⏸" : "▶"}</button>
          <button className="mag-ed-btn" type="button" onClick={() => go(-1)}
            {...hk("prev")}>⏮</button>
          <button className="mag-ed-btn" type="button" onClick={() => go(1)}
            {...hk("next")}>⏭</button>
          <span className="mag-ved-speed" {...hk("speed")}>
            {[0.25, 0.5, 1, 2].map((v) => (
              <button
                key={v}
                type="button"
                className={v === speed ? "on" : undefined}
                onClick={() => changeSpeed(v, frame)}
                
              >
                {v === 0.25 ? "¼" : v === 0.5 ? "½" : `${v}×`}
              </button>
            ))}
          </span>
          <span className="mag-ved-quality">
            <button
              className={qualityOpen ? "mag-ed-btn on" : "mag-ed-btn"}
              type="button"
              onClick={() => setQualityOpen((v) => !v)}
              aria-label="Качество"
              aria-expanded={qualityOpen}
              {...hk("quality")}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M8 5.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2Zm0 4a1.4 1.4 0 1 1 0-2.8 1.4 1.4 0 0 1 0 2.8Z"
                />
                <path
                  fill="currentColor"
                  d="m13.9 9.3.1-1.3-.1-1.3 1.2-1-1.3-2.2-1.5.5a5.6 5.6 0 0 0-2.2-1.3L9.7 1H6.3l-.4 1.7c-.8.3-1.5.7-2.2 1.3l-1.5-.5-1.3 2.2 1.2 1L2 8l.1 1.3-1.2 1 1.3 2.2 1.5-.5c.7.6 1.4 1 2.2 1.3l.4 1.7h3.4l.4-1.7c.8-.3 1.5-.7 2.2-1.3l1.5.5 1.3-2.2-1.2-1Z"
                  opacity=".55"
                />
              </svg>
            </button>
            {qualityOpen && (
              <div className="mag-ved-quality-menu" role="menu">
                {/* Ступени лестницы предлагаются только готовыми: у неготовой
                    переключение означало бы пустой экран с полосой. Они
                    доготавливаются сами и появляются здесь по мере готовности.
                    «Исходное» — особая статья: его нарезают только по просьбе,
                    поэтому оно в списке всегда, иначе попросить его было бы
                    некому и оно не появилось бы никогда. */}
                {(clip.manifest?.qualities || [])
                  .filter((q) => q.ready || q.id === "src")
                  .map((q) => (
                    <button
                      key={q.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={q.id === quality}
                      className={q.id === quality ? "on" : undefined}
                      onClick={() => {
                        setQuality(q.id);
                        setQualityOpen(false);
                      }}
                    >
                      <span>{q.label}</span>
                      <em>{q.height ? `${q.height}p` : ""}</em>
                    </button>
                  ))}
                {(clip.manifest?.qualities || [])
                  .filter((q) => !q.ready && q.id !== "src")
                  .map((q) => (
                    <i key={q.id} className="mag-ved-quality-wait">
                      {q.label}
                      <b>
                        {q.failed
                          ? "не вышло"
                          : q.chunks
                            ? `${Math.round((q.prepared / q.chunks) * 100)}%`
                            : "готовится"}
                      </b>
                    </i>
                  ))}
              </div>
            )}
          </span>
          <span className="mag-ved-time">
            {/* Номер добит до ширины последнего кадра. Иначе «0» → «250»
                раздвигает строку, и всё правее дёргается на каждом переходе
                через десяток. Добивка — цифровой пробел: он ровно в цифру. */}
            {fmtFrameTime(timeMs)} ·{" "}
            {String(frame).padStart(String(lastFrame).length, " ")}
            {/* Точка нарисована всегда и лишь гаснет: появляйся она по месту,
                строка времени раздвигалась бы и дёргала всё правее себя. */}
            <i
              className={shown.pending ? "mag-ved-wait on" : "mag-ved-wait"}
              aria-hidden={!shown.pending}
            />
          </span>
        </div>

        {/* Шкала ролика стоит в той же сетке, что и дорожки объектов: имя —
            полоса — состояние. Иначе их шкалы совпадали бы лишь на глаз, и
            «объект появляется здесь» на дорожке указывало бы не туда. */}
        <div className="g-lane mag-ved-ruler">
          <span className="g-lane-name">кадр</span>
          <span className="g-lane-track">
            <input className="mag-ved-scrub" type="range" min={0} max={lastFrame}
              value={frame} aria-label="Кадр" {...hk("scrub")}
              onChange={(e) => { stop(); setFrame(Number(e.target.value)); }} />
          </span>
          {/* Место занято всегда: появляясь по месту, метка сжимала строку. */}
          <span
            className={
              data?.materialized[String(frame)]
                ? "g-lane-state mag-ved-mark on"
                : "g-lane-state mag-ved-mark"
            }
          >
            в таске
          </span>
        </div>

        <TrackLanes
          tracks={data?.tracks || []}
          frame={frame}
          lastFrame={lastFrame}
          labelOf={labelOf}
          selected={pickedTrack}
          editable={!frozen}
          onSelect={setPickedTrack}
          onAction={onLane}
        />
      </div>

      {menu && (
        <ClassMenu
          classes={classes}
          at={{ x: menu.x, y: menu.y }}
          current={menu.i === null ? active : boxes[menu.i]?.class_index ?? null}
          onPick={(ci) => {
            if (menu.i === null) setActive(ci);
            else {
              const item = items[menu.i];
              if (item?.kind === "track") patchTrack(item.track, { class_index: ci });
              else if (item) {
                saveSingles(
                  singlesHere.map((s) =>
                    s.id === item.box.id
                      ? { class_index: ci, ...s.geometry }
                      : { class_index: s.class_index as number, ...s.geometry }
                  )
                );
              }
            }
            setMenu(null);
          }}
          deleteLabel={
            menu.i === null
              ? undefined
              : items[menu.i]?.kind === "track"
                ? "трек целиком"
                : "объект"
          }
          onDelete={
            menu.i === null || !items[menu.i]
              ? undefined
              : () => {
                  dropItem(items[menu.i as number]);
                  setMenu(null);
                }
          }
          actions={
            menu.i !== null && items[menu.i]?.kind === "single"
              ? [
                  {
                    label: "Сделать треком",
                    hint: "объект начнёт жить во времени",
                    run: () => {
                      const item = items[menu.i as number];
                      if (item.kind === "single") toTrack(item.box);
                      setMenu(null);
                    },
                  },
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
          onEnd={() => {
            const track = trackById(laneMenu.trackId);
            if (track) patchTrack(track, { end_frame: laneMenu.frame });
          }}
          onShow={() => {
            const track = trackById(laneMenu.trackId);
            if (!track) return;
            patchTrack(track, {
              hidden_ranges: (track.hidden_ranges || []).filter(
                ([from, to]) => !(from <= laneMenu.frame && laneMenu.frame < to)
              ),
            });
          }}
          onDelete={() => {
            const track = trackById(laneMenu.trackId);
            if (!track) return;
            if (!window.confirm(`Удалить объект «${trackName(track, labelOf)}» целиком?`)) return;
            guard(async () => {
              await deleteTrack(track.id);
              setPickedTrack(null);
              await load();
            });
          }}
        />
      )}
    </div>
  );
}

function same(a: CanvasBox | undefined, b: CanvasBox | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.class_index === b.class_index &&
    Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 &&
    Math.abs(a.w - b.w) < 0.01 && Math.abs(a.h - b.h) < 0.01
  );
}

function trackName(track: VideoTrack, labelOf: (ci: number) => { name: string }): string {
  return track.label || labelOf(track.class_index ?? -1).name || "объект";
}

/** Меню на дорожке: то же, что делают жестами. Жест, о котором нельзя
 *  догадаться, для нового разметчика не существует. */
function LaneMenu({
  action, track, frozen, onClose, onKey, onDropKey, onEnd, onShow, onDelete,
}: {
  action: LaneAction;
  track: VideoTrack | null;
  frozen: boolean;
  onClose: () => void;
  onKey: () => void;
  onDropKey: () => void;
  onEnd: () => void;
  onShow: () => void;
  onDelete: () => void;
}) {
  if (!track) return null;
  const hasKey = keyAt(track, action.frame) !== null;
  const state = stateAt(track, action.frame);
  const run = (fn: () => void) => () => { fn(); onClose(); };

  return (
    <>
      <div className="mag-menu-veil" onClick={onClose} onContextMenu={(e) => e.preventDefault()} />
      <div className="mag-menu g-lane-menu"
        style={{ left: action.at?.x ?? 0, top: action.at?.y ?? 0 }}>
        <div className="g-lane-menu-h">кадр {action.frame}</div>
        <button type="button" disabled={frozen} onClick={run(onKey)}>
          {hasKey ? "Обновить ключ здесь" : "Поставить ключ здесь"}
        </button>
        {hasKey && track.keys.length > 1 && (
          <button type="button" disabled={frozen} onClick={run(onDropKey)}>Снять ключ</button>
        )}
        {state?.hidden && (
          <button type="button" disabled={frozen} onClick={run(onShow)}>
            Снять заслонение
          </button>
        )}
        <button type="button" disabled={frozen} onClick={run(onEnd)}>
          Объект исчезает здесь
        </button>
        <hr />
        <button type="button" className="del" disabled={frozen} onClick={run(onDelete)}>
          Удалить объект
        </button>
      </div>
    </>
  );
}
