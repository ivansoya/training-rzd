import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createClass,
  deleteImage,
  getClasses,
  saveAnnotations,
  setImageTaskStatus,
} from "../../auth/api";
import type { ImageTaskStatus, LabelClass, TaskImage } from "../../auth/api";
import BoxCanvas from "./BoxCanvas";
import type { CanvasBox, CanvasHandle, CanvasPoint, CanvasPreview } from "./BoxCanvas";
import ClassMenu from "./ClassMenu";
import FilmStrip from "./FilmStrip";
import { useAutoLabel } from "./useAutoLabel";
import type { AutoRefine } from "../../auth/api";

const GREY = { name: "", color: "#9aa4ae" };

export default function AnnotationEditor({
  code,
  taskName,
  images,
  index,
  readOnly,
  onIndex,
  onClose,
  onChanged,
}: {
  code: string;
  taskName: string;
  images: TaskImage[];
  index: number;
  readOnly: boolean;
  onIndex: (i: number) => void;
  onClose: () => void;
  onChanged: (image: TaskImage) => void;
}) {
  const image = images[index];

  const [classes, setClasses] = useState<LabelClass[]>([]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<number | null>(null);
  const [boxes, setBoxes] = useState<CanvasBox[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [tool, setTool] = useState<"select" | "box" | "auto">("select");
  const [lock, setLock] = useState(false);
  // Полуавтомат: набор точек и ещё не закреплённая детекция.
  const [autoMode, setAutoMode] = useState<"points" | "box">("points");
  const [autoPts, setAutoPts] = useState<CanvasPoint[]>([]);
  const [autoPrev, setAutoPrev] = useState<CanvasPreview | null>(null);
  const [autoPrompt, setAutoPrompt] = useState<CanvasBox | null>(null);
  // Индекс бокса, который сейчас уточняем: на закреплении он заменяется.
  const [replacing, setReplacing] = useState<number | null>(null);
  const [autoPanel, setAutoPanel] = useState(false);
  const [refine, setRefine] = useState<AutoRefine>({
    detail: "auto", score_min: 0.3, min_area: 64, fill_holes: true, polygon_points: 64,
  });
  // Что делать после закрепления: взяться за следующий объект или выйти в выбор.
  const [afterCommit, setAfterCommit] = useState<"new" | "select">("new");
  // i === null — меню открыто на плашке активного класса, а не на детекции.
  const [menu, setMenu] = useState<{ i: number | null; x: number; y: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [filmH, setFilmH] = useState(164);
  const [saved, setSaved] = useState(true);
  const [grid, setGrid] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const canvas = useRef<CanvasHandle>(null);
  const dirty = useRef(false);

  const iw = image?.width || 1;
  const ih = image?.height || 1;
  // Забракованный кадр смотрим, но не правим: иначе он оживёт незаметно.
  const frozen = readOnly || image?.task_status === "deleted";

  useEffect(() => {
    getClasses(code).then((c) => {
      setClasses(c.classes);
      setActive((prev) => prev ?? (c.classes[0]?.class_index ?? null));
    }).catch(() => {});
  }, [code]);

  // Кадр сменился — берём его разметку как есть.
  useEffect(() => {
    setBoxes(
      (image?.boxes || []).map((b) => ({
        class_index: b.class_index, x: b.x, y: b.y, w: b.w, h: b.h,
      }))
    );
    setSelected(null);
    dirty.current = false;
    setSaved(true);
  }, [image?.id]);

  const byIndex = useMemo(() => {
    const m = new Map<number, LabelClass>();
    classes.forEach((c) => m.set(c.class_index, c));
    return m;
  }, [classes]);

  const labelOf = useCallback(
    (ci: number) => byIndex.get(ci) || GREY,
    [byIndex]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return classes;
    return classes.filter(
      (c) => c.name.toLowerCase().includes(q) || String(c.class_index) === q
    );
  }, [classes, query]);

  // Автосохранение: разметчик не должен помнить про кнопку «сохранить».
  const flush = useCallback(async () => {
    if (!dirty.current || !image) return;
    dirty.current = false;
    try {
      const res = await saveAnnotations(image.id, boxes);
      setSaved(true);
      onChanged({
        ...image,
        annotations: res.saved,
        task_status: res.task_status as ImageTaskStatus,
        boxes: boxes.map((b, i) => ({
          id: String(i),
          ...b,
          name: labelOf(b.class_index).name,
          color: labelOf(b.class_index).color,
          source: "human",
        })),
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [boxes, image, labelOf, onChanged]);

  useEffect(() => {
    if (!dirty.current) return;
    setSaved(false);
    const h = setTimeout(flush, 600);
    return () => clearTimeout(h);
  }, [boxes, flush]);

  const edit = useCallback((next: CanvasBox[]) => {
    setBoxes(next);
    dirty.current = true;
  }, []);

  // Выбор класса при выделенном боксе перекрашивает его: чаще всего класс
  // выбирают именно затем, чтобы исправить уже нарисованное.
  const pickClass = useCallback(
    (ci: number, target: number | null = selected) => {
      setActive(ci);
      if (target === null || frozen) return;
      setBoxes((prev) =>
        prev.map((b, i) => (i === target ? { ...b, class_index: ci } : b))
      );
      dirty.current = true;
    },
    [selected, frozen]
  );

  const jump = useCallback(
    async (target: number) => {
      await flush();
      if (target >= 0 && target < images.length) onIndex(target);
    },
    [flush, images.length, onIndex]
  );

  // Забракованные кадры перешагиваем: из работы они выпали, но из ленты нет.
  const go = useCallback(
    (delta: number) => {
      let i = index + delta;
      while (i >= 0 && i < images.length && images[i].task_status === "deleted") {
        i += delta;
      }
      return jump(i);
    },
    [index, images, jump]
  );

  const verdict = useCallback(
    async (status: ImageTaskStatus, advance: boolean) => {
      if (!image || readOnly) return;
      await flush();
      try {
        const res = await setImageTaskStatus(image.id, status);
        onChanged({ ...image, task_status: res.task_status });
        if (advance) go(1);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [image, readOnly, flush, onChanged, go]
  );

  // «Пусто» и «Отложить» — переключатели: нажал случайно, нажми ещё раз.
  const toggle = useCallback(
    (status: ImageTaskStatus) => {
      if (!image) return;
      const back = image.annotations > 0 ? "annotated" : "new";
      const next = image.task_status === status ? back : status;
      return verdict(next, next === status);
    },
    [image, verdict]
  );

  const trash = useCallback(async () => {
    if (!image || readOnly) return;
    // Возврат отдаёт кадру то состояние, которое отвечает его содержимому.
    if (image.task_status === "deleted") {
      return verdict(image.annotations > 0 ? "annotated" : "new", false);
    }
    await flush();
    try {
      await deleteImage(image.id);
      onChanged({ ...image, task_status: "deleted" });
      go(1);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [image, readOnly, flush, onChanged, go, verdict]);

  const pickBox = useCallback(() => {
    setTool((t) => {
      if (t === "box") { setLock((l) => !l); return t; }
      setLock(false);
      return "box";
    });
  }, []);

  // --- полуавтоматическая разметка ---------------------------------------- #

  const auto = useAutoLabel(image?.id, images[index + 1]?.id);

  const clearAuto = useCallback(() => {
    setAutoPts([]);
    setAutoPrev(null);
    setAutoPrompt(null);
    setReplacing(null);
  }, []);

  // Кадр сменился — начатое выделение к нему не относится.
  useEffect(() => { clearAuto(); }, [image?.id, clearAuto]);

  const ask = useCallback(
    async (points: CanvasPoint[], prompt: CanvasBox | null) => {
      const shape = await auto.predict(
        { points, box: prompt ? { x: prompt.x, y: prompt.y, w: prompt.w, h: prompt.h } : undefined },
        refine
      );
      if (!shape) { setAutoPrev(null); return; }
      setAutoPrev({
        ...shape.box,
        polygons: shape.polygons,
        color: labelOf(active ?? 0).color,
      });
    },
    [auto, refine, labelOf, active]
  );

  /** Закрепление: детекция становится обычным боксом, как все остальные. */
  const commitAuto = useCallback(() => {
    if (!autoPrev || active === null) return;
    const box: CanvasBox = {
      class_index: active, x: autoPrev.x, y: autoPrev.y, w: autoPrev.w, h: autoPrev.h,
    };
    if (replacing !== null && boxes[replacing]) {
      edit(boxes.map((b, i) => (i === replacing ? box : b)));
      setSelected(replacing);
    } else {
      edit([...boxes, box]);
      setSelected(boxes.length);
    }
    clearAuto();
  }, [autoPrev, active, replacing, boxes, edit, clearAuto]);

  const onAutoPoint = useCallback(
    (p: { x: number; y: number }, o: { shift: boolean; negative: boolean; onBox: number | null }) => {
      if (frozen || active === null || auto.state !== "ready") return;

      if (o.negative) {
        if (!autoPrev) return;                       // вычитать пока нечего
        const pts = [...autoPts, { x: p.x, y: p.y, label: 0 }];
        setAutoPts(pts);
        ask(pts, autoPrompt);
        return;
      }

      if (o.shift) {
        if (autoPrev) {                              // уточняем начатое
          const pts = [...autoPts, { x: p.x, y: p.y, label: 1 }];
          setAutoPts(pts);
          ask(pts, autoPrompt);
          return;
        }
        // Подхватываем выделенный бокс — неважно, чей он: нарисован рукой,
        // пришёл из импорта или от модели. Это та же цепочка «грубо → точно».
        const idx = o.onBox ?? selected;
        const base = idx !== null ? boxes[idx] : undefined;
        if (base) {
          const pts = [{ x: p.x, y: p.y, label: 1 }];
          setAutoPts(pts);
          setAutoPrompt(base);
          setReplacing(idx);
          ask(pts, base);
          return;
        }
      }

      // Обычный клик. Мимо начатой детекции — закрепляем её и идём дальше.
      if (autoPrev) {
        const inside =
          p.x >= autoPrev.x && p.x <= autoPrev.x + autoPrev.w &&
          p.y >= autoPrev.y && p.y <= autoPrev.y + autoPrev.h;
        if (inside) return;                          // случайное попадание внутрь
        commitAuto();
        if (afterCommit === "select") { setTool("select"); return; }
      }
      const pts = [{ x: p.x, y: p.y, label: 1 }];
      setAutoPts(pts);
      setAutoPrompt(null);
      setReplacing(null);
      ask(pts, null);
    },
    [frozen, active, auto.state, autoPrev, autoPts, autoPrompt, selected, boxes,
     ask, commitAuto, afterCommit]
  );

  /** Режим области: рамка — такая же подсказка модели, как точка. Показанное
   *  сначала пунктир, и только потом закрепляется — как и в режиме точек. */
  const onAutoBox = useCallback(
    (b: { x: number; y: number; w: number; h: number }) => {
      if (frozen || active === null || auto.state !== "ready") return;
      // Новая область поверх показанного означает «прежнее меня устроило».
      if (autoPrev) commitAuto();
      setAutoPts([]);
      setAutoPrompt(null);
      setReplacing(null);
      ask([], { class_index: -1, ...b });
    },
    [frozen, active, auto.state, autoPrev, commitAuto, ask]
  );

  const pickAuto = useCallback(() => {
    setTool((t) => (t === "auto" ? "select" : "auto"));
    setLock(false);
    clearAuto();
  }, [clearAuto]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.code) {
        case "Escape":
          // Esc сначала отменяет начатое, и только потом закрывает редактор.
          if (autoPrev || autoPts.length) clearAuto();
          else if (tool !== "select") { setTool("select"); setLock(false); }
          else flush().then(onClose);
          break;
        case "Space":
          // Пробел закрепляет показанное, и только без него листает дальше.
          if (autoPrev) commitAuto();
          else go(1);
          break;
        case "ArrowRight": go(1); break;
        case "ArrowLeft": go(-1); break;
        case "KeyV": setTool("select"); setLock(false); break;
        case "KeyB": if (!frozen) pickBox(); break;
        case "KeyA": if (!frozen && auto.state === "ready") pickAuto(); break;
        case "KeyE": if (!frozen) toggle("empty"); break;
        case "KeyS": if (!frozen) toggle("skipped"); break;
        case "KeyX": trash(); break;
        case "Digit0": canvas.current?.fit(); break;
        case "Delete":
        case "Backspace":
          // Delete — про разметку: удаляет выбранный бокс. Незакреплённое
          // выделение снимает Esc, иначе до боксов было бы не добраться.
          if (selected !== null && !frozen) {
            edit(boxes.filter((_, i) => i !== selected));
            setSelected(null);
          } else if (autoPrev || autoPts.length) clearAuto();
          break;
        default: {
          const digit = /^Digit([1-9])$/.exec(e.code);
          if (!digit) return;
          const c = visible[Number(digit[1]) - 1];
          if (c) pickClass(c.class_index);
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
  }, [go, flush, onClose, selected, visible, tool, frozen, pickBox, toggle,
      trash, boxes, edit, pickClass, auto.state, pickAuto, autoPrev, autoPts,
      clearAuto, commitAuto]);

  if (!image) return null;

  const isEmpty = image.task_status === "empty";
  const isSkipped = image.task_status === "skipped";
  const isDeleted = image.task_status === "deleted";

  return (
    <div className="mag-ed" role="dialog" aria-modal="true" aria-label="Разметка">
      <div className="mag-ed-head">
        <b>{taskName}</b>
        <span className="mag-ed-cnt">кадр {index + 1} из {images.length}</span>
        {/* Класс, который получат новые объекты. В списке справа он тоже
            подсвечен, но глаз при разметке смотрит не туда. */}
        {active !== null && (
          <button
            type="button"
            className={tool === "auto" ? "mag-ed-active on" : "mag-ed-active"}
            title="Сменить класс для новых объектов"
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
        {isDeleted && <span className="mag-ed-flag del">кадр забракован</span>}
        {isEmpty && <span className="mag-ed-flag nul">фоновый кадр</span>}
        {isSkipped && <span className="mag-ed-flag skip">отложен</span>}
        <span className="mag-ed-sp" />
        {error && <span className="mag-ed-err">{error}</span>}
        <span className={saved ? "mag-ed-saved" : "mag-ed-saving"}>
          {saved ? "сохранено" : "сохраняю…"}
        </span>
        {/* Приговоры кадру — одной группой: это решения, а не настройки вида. */}
        <span className="mag-ed-verdict">
          <button
            className={isEmpty ? "mag-ed-btn nul on" : "mag-ed-btn nul"}
            type="button"
            disabled={frozen}
            onClick={() => toggle("empty")}
            title="Объектов нет — фоновый кадр (E)"
          >
            Пусто
          </button>
          <button
            className={isSkipped ? "mag-ed-btn warn on" : "mag-ed-btn warn"}
            type="button"
            disabled={frozen}
            onClick={() => toggle("skipped")}
            title="Вернуться позже (S)"
          >
            Отложить
          </button>
          <button
            className={isDeleted ? "mag-ed-btn del on" : "mag-ed-btn del"}
            type="button"
            disabled={readOnly}
            onClick={trash}
            title={isDeleted ? "Вернуть кадр в работу (X)" : "Забраковать кадр (X)"}
          >
            {isDeleted ? "Вернуть" : "Удалить"}
          </button>
          <button
            className="mag-ed-btn primary"
            type="button"
            onClick={() => go(1)}
            title="Следующий кадр (Пробел)"
          >
            Далее →
          </button>
        </span>
        <button
          className="mag-ed-btn"
          type="button"
          onClick={() => flush().then(onClose)}
          aria-label="Закрыть"
        >
          ✕
        </button>
      </div>

      <div className="mag-ed-body">
        {/* Рейк: только вид и инструменты, решений по кадру здесь нет */}
        <div className="mag-ed-rail">
          <button
            className={tool === "select" ? "mag-tool on" : "mag-tool"}
            type="button"
            onClick={() => { setTool("select"); setLock(false); }}
            title="Выбор и правка — V"
          >
            ↖
          </button>
          <button
            className={tool === "box" ? "mag-tool on" : "mag-tool"}
            type="button"
            disabled={frozen}
            onClick={pickBox}
            title="Новая рамка — B, ещё раз B — залипание"
          >
            ▢
            {tool === "box" && lock && <i className="mag-tool-lock" />}
          </button>
          {/* Полуавтомат. До готовности модели кнопка приглушена и пульсирует:
              первый подъём весов занимает десятки секунд. */}
          <button
            className={
              (tool === "auto" ? "mag-tool on" : "mag-tool") +
              (auto.state === "starting" ? " warming" : "")
            }
            type="button"
            disabled={frozen || auto.state !== "ready"}
            onClick={pickAuto}
            title={
              auto.state === "ready"
                ? "Полуавтоматическая разметка — A"
                : auto.state === "error"
                  ? `Модель недоступна: ${auto.error || "неизвестная ошибка"}`
                  : "Модель готовится…"
            }
          >
            ✨
          </button>
          {tool === "auto" && (
            <button
              className={autoPanel ? "mag-tool on" : "mag-tool"}
              type="button"
              onClick={() => setAutoPanel((v) => !v)}
              title="Параметры полуавтомата"
            >
              ⚙
            </button>
          )}
          <hr />
          <button className="mag-tool" type="button" title="Приблизить"
            onClick={() => canvas.current?.zoomBy(1.3)}>
            +
          </button>
          <button className="mag-tool" type="button" title="Отдалить"
            onClick={() => canvas.current?.zoomBy(1 / 1.3)}>
            −
          </button>
          <button className="mag-tool wide" type="button" title="Вписать в окно — 0"
            onClick={() => canvas.current?.fit()}>
            {Math.round(scale * 100)}%
          </button>
          <hr />
          <button
            className={grid ? "mag-tool on" : "mag-tool"}
            type="button"
            onClick={() => setGrid((g) => !g)}
            title="Сетка на фоне"
          >
            ▦
          </button>
          <span className="mag-ed-hint-rail">
            Shift — полотно<br />колесо — зум
          </span>
        </div>

        {/* Окошко параметров полуавтомата. Показываем только то, что влияет на
            рамку: число точек контура на её границы не влияет вовсе. */}
        {tool === "auto" && autoPanel && (
          <div className="mag-auto-panel">
            <h5>Полуавтомат</h5>
            <label className="mag-auto-row">
              <span>Вид</span>
              <select
                value={autoMode}
                onChange={(e) => { setAutoMode(e.target.value as "points" | "box"); clearAuto(); }}
              >
                <option value="points">Точки</option>
                <option value="box">Область</option>
              </select>
            </label>
            <label className="mag-auto-row">
              <span>Детализация</span>
              <select
                value={refine.detail}
                onChange={(e) => setRefine((r) => ({ ...r, detail: e.target.value as AutoRefine["detail"] }))}
              >
                <option value="auto">Как решит модель</option>
                <option value="object">Объект целиком</option>
                <option value="part">Часть</option>
                <option value="subpart">Подчасть</option>
              </select>
            </label>
            <label className="mag-auto-row">
              <span>Порог</span>
              <input
                type="range" min="0" max="0.9" step="0.05"
                value={refine.score_min ?? 0}
                onChange={(e) => setRefine((r) => ({ ...r, score_min: Number(e.target.value) }))}
              />
              <b>{(refine.score_min ?? 0).toFixed(2)}</b>
            </label>
            <label className="mag-auto-row">
              <span>Мелочь, px²</span>
              <input
                type="number" min="0" step="16"
                value={refine.min_area ?? 0}
                onChange={(e) => setRefine((r) => ({ ...r, min_area: Number(e.target.value) }))}
              />
            </label>
            <label className="mag-auto-check">
              <input
                type="checkbox"
                checked={!!refine.fill_holes}
                onChange={(e) => setRefine((r) => ({ ...r, fill_holes: e.target.checked }))}
              />
              <span>Закрывать дыры в объекте</span>
            </label>
            <label className="mag-auto-check">
              <input
                type="checkbox"
                checked={afterCommit === "select"}
                onChange={(e) => setAfterCommit(e.target.checked ? "select" : "new")}
              />
              <span>После закрепления выходить в выбор</span>
            </label>
            <p className="mag-auto-hint">
              {autoMode === "points" ? (
                <>
                  Клик — объект под курсором. Shift+клик уточняет, Shift+правая
                  убирает участок, Shift по боксу доуточняет его. Пробел или
                  клик мимо — закрепить.
                </>
              ) : (
                <>
                  Обведите объект — модель уточнит границы. Пробел, клик или
                  новая рамка — закрепить.
                </>
              )}
            </p>
            {auto.error && <div className="mag-auto-err">{auto.error}</div>}
          </div>
        )}

        <BoxCanvas
          ref={canvas}
          imageId={image.id}
          fileName={image.file_name}
          width={iw}
          height={ih}
          boxes={boxes}
          labelOf={labelOf}
          editable={!frozen}
          tool={tool}
          autoMode={autoMode}
          autoPoints={autoPts}
          autoPreview={autoPrev}
          activeClass={active}
          selected={selected}
          grid={grid}
          reserve={filmH + 92}
          onSelect={setSelected}
          onBoxes={edit}
          onDrawn={() => { if (!lock) setTool("select"); }}
          onScale={setScale}
          onContext={(i, x, y) => setMenu({ i, x, y })}
          onAutoPoint={onAutoPoint}
          onAutoBox={onAutoBox}
          onAutoCommit={commitAuto}
        />

        {/* Показанное надо чем-то принять, и это должно быть видно, а не
            держаться в голове. Панель живёт ровно пока есть что закреплять. */}
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

        <aside className="mag-ed-side">
          <h5>Класс</h5>
          <input
            className="mag-ed-search"
            type="text"
            value={query}
            placeholder="Поиск класса…"
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="mag-ed-classes">
            {visible.map((c, i) => (
              <button
                key={c.id}
                type="button"
                className={c.class_index === active ? "mag-ed-cls on" : "mag-ed-cls"}
                onClick={() => pickClass(c.class_index)}
              >
                <i style={{ background: c.color }} />
                <span className="mag-ed-cls-name">{c.name}</span>
                {i < 9 && <kbd>{i + 1}</kbd>}
              </button>
            ))}
          </div>
          {/* Кнопка появляется только когда поиск ничего не дал: сначала
              посмотри, потом заводи — иначе плодятся дубликаты. */}
          {query.trim() && visible.length === 0 && !frozen && (
            <button className="mag-ed-newcls" type="button"
              onClick={() => {
                createClass(code, { name: query.trim() })
                  .then((c) => {
                    setClasses((prev) => [...prev, c]);
                    pickClass(c.class_index);
                    setQuery("");
                  })
                  .catch((e) => setError((e as Error).message));
              }}>
              Ничего не нашлось — создать «{query.trim()}»
            </button>
          )}

          <h5>На кадре · {boxes.length}</h5>
          <div className="mag-ed-objs">
            {boxes.length === 0 ? (
              <p className="mag-ed-hint">
                {isEmpty
                  ? "Кадр объявлен фоновым — объектов на нём нет."
                  : "Нажмите B и протяните рамку по объекту."}
              </p>
            ) : (
              boxes.map((b, i) => (
                <div
                  key={i}
                  className={i === selected ? "mag-ed-obj on" : "mag-ed-obj"}
                  onClick={() => setSelected(i)}
                >
                  <i style={{ background: labelOf(b.class_index).color }} />
                  <span className="mag-ed-obj-name">
                    {labelOf(b.class_index).name || `класс ${b.class_index}`}
                  </span>
                  <span className="sp">{Math.round(b.w)}×{Math.round(b.h)}</span>
                  {!frozen && (
                    <button
                      className="mag-ed-obj-x"
                      type="button"
                      aria-label="Удалить объект"
                      onClick={(e) => {
                        e.stopPropagation();
                        edit(boxes.filter((_, k) => k !== i));
                        setSelected(null);
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
          <p className="mag-ed-keys">
            <kbd>V</kbd> выбор <kbd>B</kbd> рамка <kbd>1–9</kbd> класс{" "}
            <kbd>Del</kbd> удалить объект<br />
            <kbd>E</kbd> пусто <kbd>S</kbd> отложить <kbd>X</kbd> забраковать{" "}
            <kbd>Пробел</kbd> далее <kbd>0</kbd> вписать
          </p>
        </aside>
      </div>

      <FilmStrip
        items={images.map((im) => ({
          id: im.id,
          width: im.width,
          height: im.height,
          boxes: im.boxes,
          ring: im.task_status,
          title: `${im.file_name} · ${im.annotations} разметок`,
        }))}
        index={index}
        onPick={jump}
        onHeight={setFilmH}
      />

      {menu && (
        <ClassMenu
          classes={classes}
          at={{ x: menu.x, y: menu.y }}
          current={menu.i === null ? active : boxes[menu.i]?.class_index ?? null}
          onPick={(ci) => { pickClass(ci, menu.i); setMenu(null); }}
          onDelete={
            menu.i === null || frozen
              ? undefined
              : () => {
                  const i = menu.i as number;
                  edit(boxes.filter((_, k) => k !== i));
                  setSelected(null);
                  setMenu(null);
                }
          }
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
