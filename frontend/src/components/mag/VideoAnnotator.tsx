import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createClass,
  createTrack,
  deleteTrack,
  deleteTrackKey,
  getClasses,
  getVideoAnnotations,
  previewMaterialize,
  putTrackKey,
  saveFrameBoxes,
  updateTrack,
  videoFileUrl,
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
import { useAutoLabel } from "./useAutoLabel";
import {
  boxAt,
  exportCount,
  fmtFrameTime,
  frameToMs,
  hiddenRanges,
  keyAt,
  msToFrame,
  trackEnd,
} from "./trackMath";

const GREY = { name: "", color: "#9aa4ae" };

/** Что стоит за боксом на холсте: трек или одиночный бокс этого кадра.
 *  Холст отдаёт плоский массив, и по этой карте правка попадает по адресу. */
type Item =
  | { kind: "track"; track: VideoTrack }
  | { kind: "single"; box: VideoSingleBox };

/**
 * Редактор размечаемого видео, компоновка В2 «Жизнь объектов слева».
 *
 * Кадр рисуется по серверной картинке — той же, что уйдёт в датасет. Браузерный
 * <video> нужен только чтобы искать момент: currentTime не даёт номера кадра,
 * и рисовать по нему значило бы разметить не тот кадр, который выгрузится.
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
  const lastFrame = Math.max(
    0,
    (video.frame_count ?? msToFrame(video.duration_ms || 0, fps)) - 1
  );

  const [data, setData] = useState<VideoAnnotations | null>(null);
  const [classes, setClasses] = useState<LabelClass[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [frame, setFrame] = useState(0);
  const [tool, setTool] = useState<"select" | "box" | "track" | "auto">("select");
  const [selected, setSelected] = useState<number | null>(null);
  const [pickedTrack, setPickedTrack] = useState<string | null>(null);
  // Рамка в процессе рисования или переноса: показываем её сразу, а на сервер
  // отправляем, когда рука остановилась.
  const [draft, setDraft] = useState<CanvasBox[] | null>(null);
  const [playing, setPlaying] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ frames: number; boxes: number } | null>(null);
  const [menu, setMenu] = useState<{ i: number | null; x: number; y: number } | null>(null);
  const [scale, setScale] = useState(1);

  // Полуавтомат: набор точек и ещё не закреплённая детекция.
  const [autoPts, setAutoPts] = useState<CanvasPoint[]>([]);
  const [autoPrev, setAutoPrev] = useState<CanvasPreview | null>(null);
  const [autoPanel, setAutoPanel] = useState(false);
  const [refine, setRefine] = useState<AutoRefine>({
    detail: "auto", score_min: 0.3, min_area: 64, fill_holes: true, polygon_points: 64,
  });

  const canvas = useRef<CanvasHandle>(null);
  const player = useRef<HTMLVideoElement>(null);

  const frozen = readOnly || !data?.editable;

  // --- загрузка ----------------------------------------------------------- #
  const load = useCallback(async () => {
    try {
      const fresh = await getVideoAnnotations(taskId, video.id);
      setData(fresh);
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

  // Прикидка «сколько уйдёт в проект» пересчитывается после правок, но не на
  // каждое движение мышью: на сервере это полный обход всех треков.
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

  // --- что показано на кадре ---------------------------------------------- #
  const { items, boxes } = useMemo(() => {
    const its: Item[] = [];
    const bs: CanvasBox[] = [];
    for (const track of data?.tracks || []) {
      const g = boxAt(track, frame);
      if (!g || track.class_index === null) continue;
      its.push({ kind: "track", track });
      bs.push({ class_index: track.class_index, ...g });
    }
    for (const single of data?.singles || []) {
      if (single.frame_no !== frame || single.class_index === null) continue;
      its.push({ kind: "single", box: single });
      bs.push({ class_index: single.class_index, ...single.geometry });
    }
    return { items: its, boxes: bs };
  }, [data, frame]);

  const singlesHere = useMemo(
    () => (data?.singles || []).filter((s) => s.frame_no === frame),
    [data, frame]
  );

  const currentTrack = useMemo(
    () => (data?.tracks || []).find((t) => t.id === pickedTrack) || null,
    [data, pickedTrack]
  );

  // --- сохранение --------------------------------------------------------- #
  const guard = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
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

  /** Холст отдаёт весь набор боксов. Что именно изменилось — выясняем сами:
   *  один жест правит ровно один бокс, поэтому различий не больше одного. */
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
          saveSingles([
            ...singlesHere.map((s) => ({
              class_index: s.class_index as number, ...s.geometry,
            })),
            fresh,
          ]);
        }
        return;
      }

      if (next.length < boxes.length) {
        const gone = items[boxes.findIndex((b, i) => !same(b, next[i]))] ?? items[items.length - 1];
        if (!gone) return;
        if (gone.kind === "track") removeTrackBox(gone.track);
        else {
          saveSingles(
            singlesHere
              .filter((s) => s.id !== gone.box.id)
              .map((s) => ({ class_index: s.class_index as number, ...s.geometry }))
          );
        }
        return;
      }

      const idx = next.findIndex((b, i) => !same(b, boxes[i]));
      if (idx < 0) return;
      const item = items[idx];
      const box = next[idx];
      if (item.kind === "track") {
        // Правка положения на кадре — это и есть постановка ключа: разметчик
        // сказал «здесь объект вот так», и с этого кадра счёт идёт от него.
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
    [frozen, active, boxes, items, tool, frame, guard, taskId, video.id, load,
     saveSingles, singlesHere]
  );

  /** Пока тянут рамку, холст сообщает о каждом её положении — начиная с
   *  нулевого на нажатии. Отправляем осевшее: иначе сервер получил бы точку
   *  вместо бокса, а на переносе — по запросу на каждое движение мыши. */
  const draftTimer = useRef<number>();
  const onBoxes = useCallback(
    (next: CanvasBox[]) => {
      setDraft(next);
      window.clearTimeout(draftTimer.current);
      draftTimer.current = window.setTimeout(() => commit(next), 350);
    },
    [commit]
  );

  // Ушли с кадра — черновик к нему уже не относится.
  useEffect(() => {
    setDraft(null);
    window.clearTimeout(draftTimer.current);
  }, [frame, video.id]);

  // Пришёл свежий ответ сервера — он и есть истина.
  useEffect(() => { setDraft(null); }, [data]);

  /** Удаление бокса трека на кадре. Один ключ — значит удаляют весь объект. */
  const removeTrackBox = useCallback(
    (track: VideoTrack) => {
      const key = keyAt(track, frame);
      if (track.keys.length <= 1 || !key) {
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

  // --- действия над треком ------------------------------------------------ #
  const putKeyHere = useCallback(
    (track: VideoTrack, visible: boolean) =>
      guard(async () => {
        await putTrackKey(track.id, frame, { visible });
        await load();
      }),
    [frame, guard, load]
  );

  const endTrackHere = useCallback(
    (track: VideoTrack) =>
      guard(async () => {
        await updateTrack(track.id, { end_frame: frame });
        await load();
      }),
    [frame, guard, load]
  );

  const patchTrack = useCallback(
    (track: VideoTrack, body: Parameters<typeof updateTrack>[1]) =>
      guard(async () => {
        await updateTrack(track.id, body);
        await load();
      }),
    [guard, load]
  );

  // --- навигация ---------------------------------------------------------- #
  const go = useCallback(
    (delta: number) => {
      setFrame((f) => Math.max(0, Math.min(lastFrame, f + delta)));
      setSelected(null);
    },
    [lastFrame]
  );

  const seek = useCallback(
    (target: number) => {
      const clamped = Math.max(0, Math.min(lastFrame, Math.round(target)));
      setFrame(clamped);
      setSelected(null);
      if (player.current) player.current.currentTime = frameToMs(clamped, fps) / 1000;
    },
    [lastFrame, fps]
  );

  const togglePlay = useCallback(() => {
    const el = player.current;
    if (!el) return;
    if (playing) {
      el.pause();
      return;
    }
    el.currentTime = frameToMs(frame, fps) / 1000;
    el.play().catch(() => setError("Браузер не смог проиграть этот файл — листайте кадрами."));
  }, [playing, frame, fps]);

  // Встали — снимаем номер кадра с плеера и дальше работаем по серверному кадру.
  const onPause = useCallback(() => {
    setPlaying(false);
    const el = player.current;
    if (el) setFrame(Math.max(0, Math.min(lastFrame, Math.round(el.currentTime * fps))));
  }, [fps, lastFrame]);

  // --- полуавтомат -------------------------------------------------------- #
  const ensureFrame = useCallback(
    async (ref: { video_id?: string; frame_no?: number } | Record<string, unknown>) => {
      const n = (ref as { frame_no?: number }).frame_no;
      if (n === undefined) return;
      await fetch(videoFrameUrl(taskId, video.id, n), { cache: "reload" });
    },
    [taskId, video.id]
  );

  const auto = useAutoLabel(
    { video_id: video.id, frame_no: frame },
    { video_id: video.id, frame_no: Math.min(lastFrame, frame + 1) },
    ensureFrame
  );

  const clearAuto = useCallback(() => {
    setAutoPts([]);
    setAutoPrev(null);
  }, []);

  useEffect(() => { clearAuto(); }, [frame, clearAuto]);

  const ask = useCallback(
    async (points: CanvasPoint[], prompt: CanvasBox | null) => {
      const shape = await auto.predict(
        {
          points,
          box: prompt ? { x: prompt.x, y: prompt.y, w: prompt.w, h: prompt.h } : undefined,
        },
        refine
      );
      if (!shape) { setAutoPrev(null); return; }
      setAutoPrev({ ...shape.box, polygons: shape.polygons, color: labelOf(active ?? 0).color });
    },
    [auto, refine, labelOf, active]
  );

  /** Закрепление детекции. Инструмент решает, чем она станет: боксом кадра
   *  или новым треком — полуавтомат одинаково полезен и там, и там. */
  const commitAuto = useCallback(() => {
    if (!autoPrev || active === null) return;
    const box: CanvasBox = {
      class_index: active, x: autoPrev.x, y: autoPrev.y, w: autoPrev.w, h: autoPrev.h,
    };
    if (pickedTrack && currentTrack) {
      guard(async () => {
        await putTrackKey(currentTrack.id, frame, {
          geometry: { x: box.x, y: box.y, w: box.w, h: box.h },
          source: "model",
        });
        await load();
      });
    } else {
      guard(async () => {
        const track = await createTrack(taskId, video.id, {
          class_index: active,
          frame_no: frame,
          geometry: { x: box.x, y: box.y, w: box.w, h: box.h },
          source: "model",
        });
        setPickedTrack(track.id);
        await load();
      });
    }
    clearAuto();
  }, [autoPrev, active, pickedTrack, currentTrack, frame, guard, load, taskId,
      video.id, clearAuto]);

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

  // --- клавиши ------------------------------------------------------------ #
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const step = e.shiftKey ? 10 : 1;
      switch (e.code) {
        case "Escape":
          if (autoPrev || autoPts.length) clearAuto();
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
        case "KeyK": if (!frozen && currentTrack) putKeyHere(currentTrack, true); break;
        case "KeyH": if (!frozen && currentTrack) putKeyHere(currentTrack, false); break;
        case "Digit0": canvas.current?.fit(); break;
        case "Delete":
        case "Backspace":
          if (selected !== null && !frozen) {
            const item = items[selected];
            if (item?.kind === "track") removeTrackBox(item.track);
            else if (item) {
              saveSingles(
                singlesHere
                  .filter((s) => s.id !== item.box.id)
                  .map((s) => ({ class_index: s.class_index as number, ...s.geometry }))
              );
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
  }, [tool, frozen, autoPrev, autoPts, clearAuto, onClose, togglePlay, go,
      auto.state, currentTrack, putKeyHere, selected, items, removeTrackBox,
      saveSingles, singlesHere, visibleClasses, commitAuto]);

  // Выбор бокса на холсте подсвечивает объект слева, и наоборот.
  useEffect(() => {
    if (selected === null) return;
    const item = items[selected];
    if (item?.kind === "track") setPickedTrack(item.track.id);
  }, [selected, items]);

  const timeMs = frameToMs(frame, fps);

  return (
    <div className="mag-ed mag-ved" role="dialog" aria-modal="true" aria-label="Разметка видео">
      <div className="mag-ed-head">
        <b>{taskName}</b>
        <span className="mag-ed-cnt">
          кадр {frame} / {lastFrame} · {fmtFrameTime(timeMs)}
        </span>
        {active !== null && (
          <button
            type="button"
            className={tool === "auto" ? "mag-ed-active on" : "mag-ed-active"}
            title="Класс для новых объектов"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMenu({ i: null, x: r.left, y: r.bottom + 6 });
            }}
          >
            <i style={{ background: labelOf(active).color }} />
            {labelOf(active).name || active}
            <b>▾</b>
          </button>
        )}
        <span className="mag-ed-sp" />
        {error && <span className="mag-ed-err">{error}</span>}
        {plan && (
          <span className="mag-ved-plan" title="Столько кадров уйдёт в проект при сдаче таски">
            в проект: <b>{plan.frames}</b> кадров · {plan.boxes} объектов
          </span>
        )}
        <span className={busy ? "mag-ed-saving" : "mag-ed-saved"}>
          {busy ? "сохраняю…" : "сохранено"}
        </span>
        <button className="mag-ed-btn" type="button" onClick={onClose} aria-label="Закрыть">
          ✕
        </button>
      </div>

      <div className="mag-ed-body">
        <div className="mag-ed-rail">
          <button className={tool === "select" ? "mag-tool on" : "mag-tool"} type="button"
            onClick={() => setTool("select")} title="Выбор и правка — V">↖</button>
          <button className={tool === "box" ? "mag-tool on" : "mag-tool"} type="button"
            disabled={frozen} onClick={() => setTool("box")}
            title="Бокс на этом кадре — B">▢</button>
          <button className={tool === "track" ? "mag-tool on" : "mag-tool"} type="button"
            disabled={frozen} onClick={() => setTool("track")}
            title="Трек-бокс: объект, живущий во времени — T">◇</button>
          <button
            className={(tool === "auto" ? "mag-tool on" : "mag-tool") +
              (auto.state === "starting" ? " warming" : "")}
            type="button"
            disabled={frozen || auto.state !== "ready"}
            onClick={() => { setTool("auto"); clearAuto(); }}
            title={auto.state === "ready" ? "Полуавтомат — A" : "Модель готовится…"}
          >✨</button>
          {tool === "auto" && (
            <button className={autoPanel ? "mag-tool on" : "mag-tool"} type="button"
              onClick={() => setAutoPanel((v) => !v)} title="Параметры полуавтомата">⚙</button>
          )}
          <hr />
          <button className="mag-tool" type="button" title="Приблизить"
            onClick={() => canvas.current?.zoomBy(1.3)}>+</button>
          <button className="mag-tool" type="button" title="Отдалить"
            onClick={() => canvas.current?.zoomBy(1 / 1.3)}>−</button>
          <button className="mag-tool wide" type="button" title="Вписать — 0"
            onClick={() => canvas.current?.fit()}>{Math.round(scale * 100)}%</button>
        </div>

        {/* Объекты и их время — слева: выбрал строку, тут же видишь ключи. */}
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
                Нажмите T и обведите объект — он станет треком и будет виден,
                пока вы его не уберёте.
              </p>
            ) : (
              (data?.tracks || []).map((track) => (
                <TrackRow
                  key={track.id}
                  track={track}
                  frame={frame}
                  lastFrame={lastFrame}
                  label={labelOf(track.class_index ?? -1)}
                  picked={track.id === pickedTrack}
                  onPick={() => setPickedTrack(track.id)}
                  onSeek={seek}
                />
              ))
            )}
          </div>

          {currentTrack && (
            <div className="mag-ved-props">
              <h5>{trackName(currentTrack, labelOf)}</h5>
              <label className="mag-ved-row">
                <span>Интерполяция</span>
                <input type="checkbox" checked={currentTrack.interpolate} disabled={frozen}
                  onChange={(e) => patchTrack(currentTrack, { interpolate: e.target.checked })} />
              </label>
              <label className="mag-ved-row">
                <span>Шаг выгрузки</span>
                <input type="number" min={1} value={currentTrack.export_step} disabled={frozen}
                  onChange={(e) =>
                    patchTrack(currentTrack, { export_step: Math.max(1, Number(e.target.value)) })
                  } />
              </label>
              <p className="mag-ved-note">
                В проект уйдёт {exportCount(currentTrack)} кадров этого объекта.
              </p>
              <div className="mag-ved-acts">
                <button className="mag-ed-btn" type="button" disabled={frozen}
                  onClick={() => putKeyHere(currentTrack, true)}
                  title="Закрепить положение на этом кадре — K">Ключ здесь</button>
                <button className="mag-ed-btn warn" type="button" disabled={frozen}
                  onClick={() => putKeyHere(currentTrack, false)}
                  title="Объект заслонён с этого кадра — H">Скрыт отсюда</button>
                <button className="mag-ed-btn" type="button" disabled={frozen}
                  onClick={() => endTrackHere(currentTrack)}
                  title="Объект исчезает на этом кадре">Убрать отсюда</button>
                <button className="mag-ed-btn del" type="button" disabled={frozen}
                  onClick={() => {
                    if (window.confirm(`Удалить объект «${trackName(currentTrack, labelOf)}» целиком?`)) {
                      guard(async () => {
                        await deleteTrack(currentTrack.id);
                        setPickedTrack(null);
                        await load();
                      });
                    }
                  }}>Удалить объект</button>
              </div>
            </div>
          )}
        </aside>

        {/* Пока играем — показываем плеер, встали — серверный кадр. Рисуют
            всегда по серверному: он и уйдёт в датасет. */}
        <div className="mag-ved-stage">
          <video
            ref={player}
            className={playing ? "mag-ved-player on" : "mag-ved-player"}
            src={videoFileUrl(taskId, video.id)}
            style={{ aspectRatio: `${video.width || 16} / ${video.height || 9}` }}
            onPlay={() => setPlaying(true)}
            onPause={onPause}
            onEnded={onPause}
            preload="metadata"
          />
          {!playing && (
            <BoxCanvas
              ref={canvas}
              imageId={`${video.id}:${frame}`}
              src={videoFrameUrl(taskId, video.id, frame)}
              fileName={video.file_name}
              width={video.width || 1}
              height={video.height || 1}
              boxes={draft ?? boxes}
              labelOf={labelOf}
              editable={!frozen}
              tool={tool === "track" ? "box" : tool}
              autoMode="points"
              autoPoints={autoPts}
              autoPreview={autoPrev}
              activeClass={active}
              selected={selected}
              reserve={196}
              onSelect={setSelected}
              onBoxes={onBoxes}
              onDrawn={() => setTool("select")}
              onScale={setScale}
              onContext={(i, x, y) => setMenu({ i, x, y })}
              onAutoPoint={onAutoPoint}
              onAutoBox={onAutoBox}
              onAutoCommit={commitAuto}
            />
          )}
        </div>

        {tool === "auto" && autoPanel && (
          <div className="mag-auto-panel">
            <h5>Полуавтомат</h5>
            <label className="mag-auto-row">
              <span>Детализация</span>
              <select value={refine.detail}
                onChange={(e) => setRefine((r) => ({ ...r, detail: e.target.value as AutoRefine["detail"] }))}>
                <option value="auto">Как решит модель</option>
                <option value="object">Объект целиком</option>
                <option value="part">Часть</option>
                <option value="subpart">Подчасть</option>
              </select>
            </label>
            <label className="mag-auto-row">
              <span>Порог</span>
              <input type="range" min="0" max="0.9" step="0.05" value={refine.score_min ?? 0}
                onChange={(e) => setRefine((r) => ({ ...r, score_min: Number(e.target.value) }))} />
              <b>{(refine.score_min ?? 0).toFixed(2)}</b>
            </label>
            <p className="mag-auto-hint">
              Клик — объект под курсором. Пробел или клик мимо закрепляет: если
              выбран объект, положение ляжет ключом в него, иначе появится новый.
            </p>
            {auto.error && <div className="mag-auto-err">{auto.error}</div>}
          </div>
        )}

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

      <div className="mag-ved-transport">
        <button className="mag-ed-btn" type="button" onClick={togglePlay}
          title="Играть / стоп (Пробел)">{playing ? "⏸" : "▶"}</button>
        <button className="mag-ed-btn" type="button" onClick={() => go(-1)}
          title="Кадр назад (←)">⏮</button>
        <button className="mag-ed-btn" type="button" onClick={() => go(1)}
          title="Кадр вперёд (→)">⏭</button>
        <span className="mag-ved-time">{fmtFrameTime(timeMs)} · {frame}</span>

        <input
          className="mag-ved-scrub"
          type="range"
          min={0}
          max={lastFrame}
          value={frame}
          aria-label="Кадр"
          onChange={(e) => seek(Number(e.target.value))}
        />

        {data?.materialized[String(frame)] && (
          <span className="mag-ved-mark" title="Этот кадр уже в проекте — правка обновит его">
            кадр в проекте
          </span>
        )}
        <span className="mag-ed-keys">
          <kbd>T</kbd> трек <kbd>B</kbd> бокс <kbd>K</kbd> ключ <kbd>H</kbd> скрыт{" "}
          <kbd>Shift</kbd>+←→ по 10
        </span>
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
          onClose={() => setMenu(null)}
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

/** Строка объекта со своей дорожкой: жизнь трека, ключи и заслонённые куски. */
function TrackRow({
  track, frame, lastFrame, label, picked, onPick, onSeek,
}: {
  track: VideoTrack;
  frame: number;
  lastFrame: number;
  label: { name: string; color: string };
  picked: boolean;
  onPick: () => void;
  onSeek: (frame: number) => void;
}) {
  const span = Math.max(1, lastFrame);
  const pct = (f: number) => `${Math.max(0, Math.min(100, (f / span) * 100))}%`;
  const end = trackEnd(track);
  const here = boxAt(track, frame) !== null;

  return (
    <div className={picked ? "mag-ved-obj on" : "mag-ved-obj"} onClick={onPick}>
      <div className="mag-ved-obj-head">
        <i style={{ background: label.color }} />
        <span className="mag-ved-obj-name">{track.label || label.name || "объект"}</span>
        <span className="mag-ved-obj-n">
          {track.keys.length} кл{here ? "" : " · не здесь"}
        </span>
      </div>
      <div
        className="mag-ved-track"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onSeek(((e.clientX - r.left) / r.width) * span);
        }}
      >
        <span className="mag-ved-life"
          style={{ left: pct(track.start_frame), right: `${100 - (end / span) * 100}%`,
                   background: label.color }} />
        {hiddenRanges(track).map(([from, to], i) => (
          <span key={i} className="mag-ved-occl"
            style={{ left: pct(from), width: pct(Math.max(0, to - from)) }} />
        ))}
        {track.keys.map((k) => (
          <span key={k.frame_no}
            className={k.visible ? "mag-ved-key" : "mag-ved-key off"}
            style={{ left: pct(k.frame_no), background: label.color }} />
        ))}
        <span className="mag-ved-needle" style={{ left: pct(frame) }} />
      </div>
    </div>
  );
}
