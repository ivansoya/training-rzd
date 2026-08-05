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
  | { kind: "pan"; px: number; py: number; ox: number; oy: number };

export interface CanvasHandle {
  zoomBy(factor: number): void;
  fit(): void;
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
  tool?: "select" | "box";
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
}>(function BoxCanvas(
  {
    imageId, fileName, width, height, boxes, labelOf, hidden, labels = true,
    editable = false, tool = "select", activeClass = null, selected = null,
    grid = true, reserve = 210, onSelect, onBoxes, onDrawn, onScale, onContext,
  },
  ref
) {
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const [hires, setHires] = useState(false);
  const [dragKind, setDragKind] = useState<Drag["kind"] | null>(null);
  const [shift, setShift] = useState(false);
  // Где кадр оказался на экране: подписи рисуем поверх, вне трансформа.
  const [rect, setRect] = useState({ l: 0, t: 0, w: 0, h: 0 });

  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
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
    if (d?.kind !== "new") return;
    // Промах мышью — не объект.
    const b = boxesRef.current[d.i];
    if (!b || b.w < MIN_BOX || b.h < MIN_BOX) {
      onBoxes?.(boxesRef.current.filter((_, k) => k !== d.i));
      onSelect?.(null);
    }
    onDrawn?.();
  }, [onBoxes, onSelect, onDrawn]);

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
    if (e.button !== 0) return;
    // Гасим нативный drag и выделение текста: именно они рождают призрак бокса.
    e.preventDefault();
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
                  onSelect?.(i);
                  onContext(i, e.clientX, e.clientY);
                }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  onSelect?.(i);
                  // В просмотре бокс только выбирается, а протяжка панорамит:
                  // событие нарочно уходит дальше на холст.
                  if (!editable || e.shiftKey) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const p = toImage(e);
                  begin(e, { kind: "move", i, dx: p.x - b.x, dy: p.y - b.y });
                }}
              >
                {on && editable && HANDLES.map((corner) => (
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
