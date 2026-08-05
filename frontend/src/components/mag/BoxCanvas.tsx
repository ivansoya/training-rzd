import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { imageFileUrl, imagePreviewUrl } from "../../auth/api";

/** Холст с кадром и боксами: зум, панорама, рисование, перенос, ресайз.
 *
 * Один и тот же холст под редактором таски и под просмотром датасета — иначе
 * зум, обводка выделения и ловушки перетаскивания разъезжаются по копиям.
 * Всё перетаскивание идёт только через pointer-события холста: нативный drag
 * браузера подавляется, иначе бокс уезжает призраком и залипает на курсоре.
 */

export interface CanvasBox {
  class_index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

type Drag =
  | { kind: "new"; i: number; x0: number; y0: number }
  | { kind: "move"; i: number; dx: number; dy: number }
  | { kind: "resize"; i: number; corner: string }
  | { kind: "pan"; px: number; py: number; ox: number; oy: number }
  // Выделение области под подсказку модели — боксом оно ещё не становится.
  | { kind: "lasso"; x0: number; y0: number }
  // В полуавтомате Shift значит и точку, и панораму: клик без движения —
  // точка, протяжка — панорама. Развести их можно только по факту движения.
  | { kind: "maybe"; px: number; py: number; ox: number; oy: number;
      ix: number; iy: number; shift: boolean };

export interface CanvasHandle {
  zoomBy(factor: number): void;
  fit(): void;
}

/** Подсказка для модели: где объект (label 1) и где его точно нет (label 0). */
export interface CanvasPoint {
  x: number;
  y: number;
  label: number;
}

/** Ещё не закреплённая детекция: контур того, что модель сочла объектом. */
export interface CanvasPreview {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Куски маски. Рамка охватывает их все, обводка обязана показывать столько же. */
  polygons?: [number, number][][];
  color: string;
}

const MIN_BOX = 3;
const MAX_ZOOM = 12;
// Превью — 1280 px; примерно с двукратного оно мылится, тогда тянем оригинал.
const HIRES_AT = 2;
const HANDLES = ["tl", "tc", "tr", "lc", "rc", "bl", "bc", "br"];

function clampBox(b: CanvasBox, w: number, h: number): CanvasBox {
  // За границей кадра бокс даст координату вне [0,1] при экспорте — ровно ту,
  // которую импорт отбраковывает.
  let { x, y, w: bw, h: bh } = b;
  if (bw < 0) { x += bw; bw = -bw; }
  if (bh < 0) { y += bh; bh = -bh; }
  const x2 = Math.min(x + bw, w);
  const y2 = Math.min(y + bh, h);
  x = Math.max(0, Math.min(x, w));
  y = Math.max(0, Math.min(y, h));
  return { ...b, x, y, w: x2 - x, h: y2 - y };
}

const BoxCanvas = forwardRef<CanvasHandle, {
  imageId: string;
  fileName?: string;
  width: number;
  height: number;
  boxes: CanvasBox[];
  labelOf: (classIndex: number) => { name: string; color: string };
  hidden?: Set<number>;
  labels?: boolean;
  editable?: boolean;
  tool?: "select" | "box" | "auto";
  /** Вид полуавтомата: набор точек или выделение области. */
  autoMode?: "points" | "box";
  autoPoints?: CanvasPoint[];
  autoPreview?: CanvasPreview | null;
  activeClass?: number | null;
  selected?: number | null;
  grid?: boolean;
  /** Сколько пикселей по вертикали занято шапкой и лентой. */
  reserve?: number;
  onSelect?: (i: number | null) => void;
  onBoxes?: (next: CanvasBox[]) => void;
  onDrawn?: () => void;
  onScale?: (s: number) => void;
  /** Правая кнопка на боксе — сменить класс. */
  onContext?: (i: number, clientX: number, clientY: number) => void;
  /** Клик в полуавтомате. Смысл жеста решает редактор, холст только сообщает. */
  onAutoPoint?: (
    p: { x: number; y: number },
    opts: { shift: boolean; negative: boolean; onBox: number | null }
  ) => void;
  /** Область, выделенная в полуавтомате: подсказка-бокс для модели. */
  onAutoBox?: (b: { x: number; y: number; w: number; h: number }) => void;
  /** Клик без протяжки в режиме области — «закрепить показанное». */
  onAutoCommit?: () => void;
}>(function BoxCanvas(
  {
    imageId, fileName, width, height, boxes, labelOf, hidden, labels = true,
    editable = false, tool = "select", autoMode = "points", autoPoints,
    autoPreview = null, activeClass = null, selected = null,
    grid = true, reserve = 210, onSelect, onBoxes, onDrawn, onScale, onContext,
    onAutoPoint, onAutoBox, onAutoCommit,
  },
  ref
) {
  const [lasso, setLasso] = useState<CanvasBox | null>(null);
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const [hires, setHires] = useState(false);
  const [dragKind, setDragKind] = useState<Drag["kind"] | null>(null);
  const [shift, setShift] = useState(false);
  // Где кадр оказался на экране: подписи рисуем поверх, вне трансформа.
  const [rect, setRect] = useState({ l: 0, t: 0, w: 0, h: 0 });

  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const lassoRef = useRef<CanvasBox | null>(null);
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;

  useEffect(() => {
    setView({ s: 1, x: 0, y: 0 });
    setHires(false);
  }, [imageId]);

  useEffect(() => { onScale?.(view.s); }, [view.s, onScale]);

  // Меряем после каждой отрисовки: зум и панорама двигают кадр, а подписи
  // должны идти следом. Сравнение с прежним значением обрывает цикл.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const frame = frameRef.current;
    if (!stage || !frame) return;
    const s = stage.getBoundingClientRect();
    const f = frame.getBoundingClientRect();
    const next = { l: f.left - s.left, t: f.top - s.top, w: f.width, h: f.height };
    setRect((prev) =>
      prev.l === next.l && prev.t === next.t && prev.w === next.w && prev.h === next.h
        ? prev
        : next
    );
  });

  const [, bump] = useState(0);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ro = new ResizeObserver(() => bump((n) => n + 1));
    ro.observe(stage);
    return () => ro.disconnect();
  }, []);

  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    const box = stageRef.current?.getBoundingClientRect();
    if (!box) return;
    // Точка под курсором остаётся на месте: иначе кадр уезжает из-под руки.
    const px = clientX - (box.left + box.width / 2);
    const py = clientY - (box.top + box.height / 2);
    setView((v) => {
      const s = Math.max(1, Math.min(v.s * factor, MAX_ZOOM));
      const k = s / v.s;
      if (s >= HIRES_AT) setHires(true);
      return { s, x: px - k * (px - v.x), y: py - k * (py - v.y) };
    });
  }, []);

  useImperativeHandle(ref, () => ({
    zoomBy(factor: number) {
      const box = stageRef.current?.getBoundingClientRect();
      if (box) zoomAt(box.left + box.width / 2, box.top + box.height / 2, factor);
    },
    fit() { setView({ s: 1, x: 0, y: 0 }); },
  }), [zoomAt]);

  // Слушатель колеса — нативный и не пассивный: у React onWheel пассивный, а
  // без preventDefault браузер забирает Ctrl+колесо под свой зум страницы.
  // Поэтому колесо здесь зумит и без модификатора: сцене всё равно нечего
  // прокручивать, а привычка «Ctrl+колесо» продолжает работать.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!e.deltaY) return;
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const finish = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragKind(null);
    if (d?.kind === "maybe") {
      // Мышь не сдвинулась — это был клик по кадру, а не панорама.
      onAutoPoint?.({ x: d.ix, y: d.iy }, { shift: d.shift, negative: false, onBox: null });
      return;
    }
    if (d?.kind === "lasso") {
      const b = lassoRef.current;
      lassoRef.current = null;
      setLasso(null);
      // Протяжка — новая подсказка модели, клик без протяжки — «закрепить».
      if (b && b.w >= MIN_BOX && b.h >= MIN_BOX) onAutoBox?.({ x: b.x, y: b.y, w: b.w, h: b.h });
      else onAutoCommit?.();
      return;
    }
    if (d?.kind !== "new") return;
    // Промах мышью — не объект.
    const b = boxesRef.current[d.i];
    if (!b || b.w < MIN_BOX || b.h < MIN_BOX) {
      onBoxes?.(boxesRef.current.filter((_, k) => k !== d.i));
      onSelect?.(null);
    }
    onDrawn?.();
  }, [onBoxes, onSelect, onDrawn, onAutoPoint, onAutoBox, onAutoCommit]);

  // Страховка от залипания: если pointerup потерялся (нативный drag, уход из
  // окна, Alt+Tab), бокс иначе продолжает ехать за курсором.
  useEffect(() => {
    function stop() { if (dragRef.current) finish(); }
    function onShift(e: KeyboardEvent) { setShift(e.shiftKey); }
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
    window.addEventListener("keydown", onShift);
    window.addEventListener("keyup", onShift);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      window.removeEventListener("keydown", onShift);
      window.removeEventListener("keyup", onShift);
    };
  }, [finish]);

  function toImage(e: { clientX: number; clientY: number }) {
    const rect = frameRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * width,
      y: ((e.clientY - rect.top) / rect.height) * height,
    };
  }

  function begin(e: ReactPointerEvent, d: Drag) {
    stageRef.current?.setPointerCapture(e.pointerId);
    dragRef.current = d;
    setDragKind(d.kind);
  }

  function onStageDown(e: ReactPointerEvent<HTMLDivElement>) {
    // Shift плюс правая кнопка — «этого участка в объекте нет». Только в
    // режиме точек: в режиме области уточнять нечем, там работает рамка.
    if (e.button === 2 && tool === "auto" && autoMode === "points" && editable && e.shiftKey) {
      e.preventDefault();
      onAutoPoint?.(toImage(e), { shift: true, negative: true, onBox: null });
      return;
    }
    if (e.button !== 0) return;
    // Гасим нативный drag и выделение текста: именно они рождают призрак бокса.
    e.preventDefault();
    if (tool === "auto" && editable) {
      if (autoMode === "box") {
        if (e.shiftKey) {
          begin(e, { kind: "pan", px: e.clientX, py: e.clientY, ox: view.x, oy: view.y });
          return;
        }
        const p = toImage(e);
        lassoRef.current = { class_index: -1, x: p.x, y: p.y, w: 0, h: 0 };
        setLasso(lassoRef.current);
        begin(e, { kind: "lasso", x0: p.x, y0: p.y });
        return;
      }
      const p = toImage(e);
      begin(e, {
        kind: "maybe", px: e.clientX, py: e.clientY, ox: view.x, oy: view.y,
        ix: p.x, iy: p.y, shift: e.shiftKey,
      });
      return;
    }
    if (e.shiftKey || !editable) {
      begin(e, { kind: "pan", px: e.clientX, py: e.clientY, ox: view.x, oy: view.y });
      return;
    }
    if (tool === "box" && activeClass !== null) {
      const p = toImage(e);
      const i = boxesRef.current.length;
      onBoxes?.([...boxesRef.current, { class_index: activeClass, x: p.x, y: p.y, w: 0, h: 0 }]);
      onSelect?.(i);
      begin(e, { kind: "new", i, x0: p.x, y0: p.y });
      return;
    }
    onSelect?.(null);
  }

  function onStageMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === "maybe") {
      if (Math.abs(e.clientX - d.px) < 3 && Math.abs(e.clientY - d.py) < 3) return;
      dragRef.current = { kind: "pan", px: d.px, py: d.py, ox: d.ox, oy: d.oy };
      setDragKind("pan");
      return;
    }
    if (d.kind === "lasso") {
      const p = toImage(e);
      const next = clampBox(
        { class_index: -1, x: d.x0, y: d.y0, w: p.x - d.x0, h: p.y - d.y0 }, width, height
      );
      lassoRef.current = next;
      setLasso(next);
      return;
    }
    if (d.kind === "pan") {
      setView((v) => ({
        ...v,
        x: d.ox + (e.clientX - d.px),
        y: d.oy + (e.clientY - d.py),
      }));
      return;
    }
    const p = toImage(e);
    const next = [...boxesRef.current];
    const b = next[d.i];
    if (!b) return;
    if (d.kind === "new") {
      next[d.i] = clampBox(
        { ...b, x: d.x0, y: d.y0, w: p.x - d.x0, h: p.y - d.y0 }, width, height
      );
    } else if (d.kind === "move") {
      // Упираем позицию, а не режем размер: у края бокс должен вставать,
      // а не сжиматься — размер человек уже подобрал.
      next[d.i] = {
        ...b,
        x: Math.max(0, Math.min(p.x - d.dx, width - b.w)),
        y: Math.max(0, Math.min(p.y - d.dy, height - b.h)),
      };
    } else {
      let { x, y, w, h } = b;
      if (d.corner.includes("l")) { w += x - p.x; x = p.x; }
      if (d.corner.includes("r")) { w = p.x - x; }
      if (d.corner.includes("t")) { h += y - p.y; y = p.y; }
      if (d.corner.includes("b")) { h = p.y - y; }
      next[d.i] = clampBox({ ...b, x, y, w, h }, width, height);
    }
    onBoxes?.(next);
  }

  const cursor = dragKind === "pan"
    ? "grabbing"
    : tool === "auto" && editable ? "auto"
    : shift || !editable ? "pan"
    : tool === "box" ? "draw" : "pick";

  return (
    <div
      className={`mag-cv ${grid ? "grid" : ""} cur-${cursor}`}
      ref={stageRef}
      onPointerDown={onStageDown}
      onPointerMove={onStageMove}
      onPointerUp={finish}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="mag-cv-canvas"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
          // Рамки и якоря не должны толстеть вместе с кадром.
          ["--z" as string]: view.s,
        }}
      >
        <div className="mag-cv-frame" ref={frameRef}>
          <img
            src={imagePreviewUrl(imageId)}
            alt={fileName || ""}
            draggable={false}
            style={{ maxHeight: `calc(100vh - ${reserve}px)` }}
          />
          {/* Оригинал приезжает вторым слоем: подмена src дала бы моргание */}
          {hires && (
            <img className="mag-cv-hires" src={imageFileUrl(imageId)} alt="" draggable={false} />
          )}
          {boxes.map((b, i) => {
            if (hidden?.has(b.class_index)) return null;
            const meta = labelOf(b.class_index);
            const on = i === selected;
            return (
              <span
                key={i}
                className={on ? "mag-cv-box on" : "mag-cv-box"}
                style={{
                  left: `${(b.x / width) * 100}%`,
                  top: `${(b.y / height) * 100}%`,
                  width: `${(b.w / width) * 100}%`,
                  height: `${(b.h / height) * 100}%`,
                  ["--bc" as string]: meta.color,
                }}
                onContextMenu={(e) => {
                  if (!editable || !onContext) return;
                  e.preventDefault();
                  e.stopPropagation();
                  // Shift+правая в полуавтомате — «убрать этот участок»,
                  // точку уже поставил обработчик холста; меню тут лишнее.
                  if (tool === "auto" && e.shiftKey) return;
                  onSelect?.(i);
                  onContext(i, e.clientX, e.clientY);
                }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  if (tool !== "auto") onSelect?.(i);
                  // В полуавтомате бокс не таскают: Shift по нему — «доуточни
                  // вот этот», обычный клик — начало нового объекта. В режиме
                  // области событие уходит на холст: рамку рисуют и поверх
                  // готовых боксов.
                  if (tool === "auto" && editable) {
                    if (autoMode !== "points") return;
                    e.preventDefault();
                    e.stopPropagation();
                    // Выбор меняем только при подхвате: иначе обычный клик
                    // забирал бы выделение, а Delete удалял не то.
                    if (e.shiftKey) onSelect?.(i);
                    onAutoPoint?.(toImage(e), {
                      shift: e.shiftKey, negative: false, onBox: i,
                    });
                    return;
                  }
                  // В просмотре бокс только выбирается, а протяжка панорамит:
                  // событие нарочно уходит дальше на холст.
                  if (!editable || e.shiftKey) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const p = toImage(e);
                  begin(e, { kind: "move", i, dx: p.x - b.x, dy: p.y - b.y });
                }}
              >
                {on && editable && tool !== "auto" && HANDLES.map((corner) => (
                  <span
                    key={corner}
                    className={`mag-cv-h ${corner}`}
                    onPointerDown={(e) => {
                      if (e.button !== 0 || e.shiftKey) return;
                      e.preventDefault();
                      e.stopPropagation();
                      begin(e, { kind: "resize", i, corner });
                    }}
                  />
                ))}
              </span>
            );
          })}

        </div>
      </div>

      {/* Слой полуавтомата — поверх сцены и вне трансформа. Внутри него
          размеры пришлось бы делить на масштаб, а доли пикселя браузер
          округляет по-разному: точка вытягивалась в овал, а её обводка
          поднималась до целого пикселя и съедала заливку. */}
      {(lasso || autoPreview || (autoPoints && autoPoints.length > 0)) && (
        <div className="mag-cv-over">
          {lasso && (
            <span
              className="mag-cv-lasso"
              style={{
                left: rect.l + (lasso.x / width) * rect.w,
                top: rect.t + (lasso.y / height) * rect.h,
                width: (lasso.w / width) * rect.w,
                height: (lasso.h / height) * rect.h,
              }}
            />
          )}

          {/* Предварительная детекция: контур того, что модель сочла объектом,
              и рамка вокруг. По одной рамке не понять, то ли она схватила. */}
          {autoPreview && (
            <>
              <span
                className="mag-cv-pre"
                style={{
                  left: rect.l + (autoPreview.x / width) * rect.w,
                  top: rect.t + (autoPreview.y / height) * rect.h,
                  width: (autoPreview.w / width) * rect.w,
                  height: (autoPreview.h / height) * rect.h,
                  ["--bc" as string]: autoPreview.color,
                }}
              />
              {!!autoPreview.polygons?.length && (
                <svg
                  className="mag-cv-mask"
                  viewBox={`0 0 ${width} ${height}`}
                  preserveAspectRatio="none"
                  style={{ left: rect.l, top: rect.t, width: rect.w, height: rect.h }}
                >
                  {autoPreview.polygons.map((ring, i) =>
                    ring.length > 2 ? (
                      <polygon
                        key={i}
                        points={ring.map((p) => p.join(",")).join(" ")}
                        style={{ stroke: autoPreview.color }}
                        vectorEffect="non-scaling-stroke"
                      />
                    ) : null
                  )}
                </svg>
              )}
            </>
          )}

          {/* Точки-подсказки: сплошная — объект здесь, полая — здесь его нет */}
          {autoPoints?.map((p, i) => (
            <span
              key={i}
              className={p.label ? "mag-cv-pt" : "mag-cv-pt neg"}
              style={{
                left: rect.l + (p.x / width) * rect.w,
                top: rect.t + (p.y / height) * rect.h,
              }}
            />
          ))}
        </div>
      )}

      {/* Подписи — поверх сцены и вне трансформа: внутри масштабируемого слоя
          текст растрируется в уменьшенном виде и на зуме рассыпается. */}
      {labels && (
        <div className="mag-cv-labels">
          {boxes.map((b, i) => {
            if (hidden?.has(b.class_index)) return null;
            const meta = labelOf(b.class_index);
            return (
              <span
                key={i}
                className="mag-cv-lb"
                style={{
                  left: rect.l + (b.x / width) * rect.w,
                  top: rect.t + (b.y / height) * rect.h,
                  background: meta.color,
                }}
              >
                {meta.name || b.class_index}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
});

export default BoxCanvas;
