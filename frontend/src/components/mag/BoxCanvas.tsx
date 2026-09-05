import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { imageFileUrl, imagePreviewUrl } from "../../auth/api";
import * as poly from "./polygon";
import type { Point, Ring } from "./polygon";
import {
  HIT,
  affordance,
  diamond,
  showVertices,
  toImageDistance,
  toScreen,
  type Rect,
} from "./overlay";

/** Холст с кадром и разметкой: зум, панорама, рисование, перенос, правка.
 *
 * Один и тот же холст под редактором таски, просмотром датасета и редактором
 * видео — иначе зум, обводка выделения и ловушки перетаскивания разъезжаются
 * по копиям. Всё перетаскивание идёт только через pointer-события холста:
 * нативный drag браузера подавляется, иначе объект уезжает призраком и
 * залипает на курсоре.
 *
 * **Разметка рисуется одним SVG поверх кадра и вне его трансформа.** Внутри
 * трансформа толщины приходилось делить на масштаб, и на зуме 12 рамка
 * становилась 0.167px, а якорь 0.83px со смещением в полпикселя — величины,
 * которые браузер округляет каждую грань по-своему. Слой подписей и слой
 * полуавтомата ушли отсюда раньше и по той же причине; теперь ушло всё.
 * Арифметика слоя — в `overlay.ts`, и она закрыта числами.
 */

export interface CanvasBox {
  class_index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Объект разметки: бокс или полигон.
 *
 * У полигона `parts` — его кольца, а `x/y/w/h` — охватывающая рамка по всем
 * частям сразу. Рамка заполнена всегда, и это не избыточность: по ней стоит
 * подпись класса, по ней же считает выгрузка боксами, и всё, что умеет только
 * прямоугольники, продолжает работать, не зная о контурах.
 */
export interface CanvasShape extends CanvasBox {
  kind?: "bbox" | "polygon";
  parts?: Ring[];
}

type Drag =
  | { kind: "new"; i: number; x0: number; y0: number }
  // Перенос объекта или одной его части — решает тумблер «части по отдельности».
  | { kind: "move"; i: number; part: number | null; dx: number; dy: number }
  | { kind: "resize"; i: number; corner: string }
  // Вершина контура: тянут одну точку, остальные стоят.
  | { kind: "vertex"; i: number; part: number; vertex: number }
  | { kind: "pan"; px: number; py: number; ox: number; oy: number }
  // Выделение области под подсказку модели — объектом оно ещё не становится.
  | { kind: "lasso"; x0: number; y0: number }
  // В полуавтомате Shift значит и точку, и панораму: клик без движения —
  // точка, протяжка — панорама. Развести их можно только по факту движения.
  | { kind: "maybe"; px: number; py: number; ox: number; oy: number;
      ix: number; iy: number; shift: boolean };

export interface CanvasHandle {
  zoomBy(factor: number): void;
  fit(): void;
  /** Замкнуть рисуемый контур, если точек уже хватает. */
  closePolygon(): void;
  /** Бросить рисуемый контур целиком. */
  cancelPolygon(): void;
  /** Убрать последнюю поставленную точку. */
  undoPoint(): void;
  /** Рисуется ли сейчас контур — по этому редактор решает, чей Escape. */
  drawing(): boolean;
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
// Радиус ромба вершины в экранных пикселях. Ромб той же ширины, что квадратный
// якорь, «весит» меньше: у него на угол приходится вдвое меньше площади.
const VERTEX_R = 7;
// Углы и середины: середины прибавляются только на крупном объекте.
const CORNERS = new Set(["tl", "tr", "bl", "br"]);

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

/** Рамка объекта. У контура считается из точек: пока вершину тянут, поле
 *  `x/y/w/h` устарело, а подпись обязана ехать следом. */
function boundsOf(s: CanvasShape): CanvasBox {
  if (s.parts?.length) {
    const b = poly.bounds(s.parts);
    if (b) return { ...s, ...b };
  }
  return s;
}

function isPoly(s: CanvasShape): boolean {
  return !!s.parts?.length;
}

/** Кадр ролика на холсте.
 *
 * Разжатый кадр — не файл, грузить его неоткуда: он уже в памяти. Пока едет
 * следующий, на холсте остаётся предыдущий: гасить картинку на время разжатия
 * значило бы моргать при каждом шаге стрелкой.
 */
function BitmapView({
  bitmap, width, height, maxHeight,
}: {
  bitmap: ImageBitmap | null;
  width: number;
  height: number;
  maxHeight: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !bitmap) return;
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    try {
      ctx.drawImage(bitmap, 0, 0);
    } catch {
      // Картинку успели закрыть, пока мы до неё добирались: следующий кадр
      // приедет и перерисует. Ронять отрисовку из-за этого незачем.
    }
  }, [bitmap]);

  // До первого кадра размер берётся у исходника: иначе холст встанет в свои
  // стандартные 300×150 и вся вёрстка дёрнется, когда приедет картинка.
  return (
    <canvas
      ref={ref}
      width={width}
      height={height}
      style={{ maxHeight }}
    />
  );
}

const BoxCanvas = forwardRef<CanvasHandle, {
  /** Ключ картинки: по нему сбрасывается зум при смене кадра. Для изображения
   *  это его id, для кадра видео — номер кадра. */
  imageId: string;
  /** Готовый адрес картинки. Кадр видео приходит из декодера одним размером,
   *  и превью с оригиналом у него не различаются — значит адрес задаёт хозяин. */
  src?: string;
  /** Готовая картинка вместо адреса: кадр ролика, разжатый в браузере. Такой
   *  кадр не существует отдельным файлом, и грузить его неоткуда — он уже
   *  здесь, в памяти. Владеет им хозяин: холст только рисует. */
  bitmap?: ImageBitmap | null;
  fileName?: string;
  width: number;
  height: number;
  boxes: CanvasShape[];
  labelOf: (classIndex: number) => { name: string; color: string };
  /** Индексы объектов, которые рисуются прерывисто: объект на кадре есть, но
   *  заслонён, и в разметку этот кадр не пойдёт. */
  dashed?: Set<number>;
  hidden?: Set<number>;
  labels?: boolean;
  editable?: boolean;
  /** Картинка догоняет запрошенный кадр. Рисовать в это время нельзя: объект
   *  привязался бы к кадру, которого на экране не было. Курсор говорит об
   *  этом прямо — молчаливый отказ читался бы как поломка мыши. */
  waiting?: boolean;
  tool?: "select" | "box" | "polygon";
  /** Полуавтомат — не инструмент, а способ ввода поверх текущего: он меняет,
   *  чем объект рисуют, а не то, что получится. Включён вместе с `box` —
   *  закрепляется бокс, вместе с `polygon` — контур. */
  auto?: boolean;
  /** Вид полуавтомата: набор точек или выделение области. */
  autoMode?: "points" | "box";
  autoPoints?: CanvasPoint[];
  autoPreview?: CanvasPreview | null;
  activeClass?: number | null;
  selected?: number | null;
  /** Какая часть выбранного объекта выделена. Части одного объекта выделяются
   *  по отдельности: у разорванного вагона половины лежат в разных местах
   *  кадра, и подвинуть их вместе — не то же самое, что подвинуть каждую. */
  selectedPart?: number | null;
  /** Тумблер «двигать части по отдельности». Выключен — тянется весь объект;
   *  включён — только выделенная часть. Настройка живёт у редактора: она про
   *  привычку человека, а не про состояние холста. */
  splitParts?: boolean;
  /** Можно ли вообще двигать контуры. По умолчанию **нельзя**: контур правят
   *  по вершинам, а перенос целиком нужен редко и случается легко — достаточно
   *  промахнуться мимо вершины и повести мышь, и вся обводка уезжает с
   *  объекта, к которому её подгоняли. */
  canMovePoly?: boolean;
  grid?: boolean;
  /** Сколько пикселей по вертикали занято шапкой и лентой. */
  reserve?: number;
  onSelect?: (i: number | null, part?: number | null) => void;
  onBoxes?: (next: CanvasShape[]) => void;
  onDrawn?: () => void;
  onScale?: (s: number) => void;
  /** Правая кнопка на объекте — меню. `part` называет кольцо под курсором
   *  («убрать этот контур» относится к нему), `vertex` — вершину, если нажали
   *  прямо на неё. */
  onContext?: (
    i: number,
    clientX: number,
    clientY: number,
    at?: { part?: number; vertex?: number }
  ) => void;
  /** Замкнули контур. Холст отдаёт кольцо, а решает редактор: новый это
   *  объект или ещё одна часть выбранного. */
  onPolygon?: (ring: Ring) => void;
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
    imageId, src, bitmap, fileName, width, height, boxes, labelOf, dashed, hidden,
    labels = true, editable = false, waiting = false, tool = "select", auto = false,
    autoMode = "points", autoPoints, autoPreview = null, activeClass = null,
    selected = null, selectedPart = null, splitParts = false, canMovePoly = false,
    grid = true, reserve = 210, onSelect, onBoxes, onDrawn,
    onScale, onContext, onPolygon, onAutoPoint, onAutoBox, onAutoCommit,
  },
  ref
) {
  const [lasso, setLasso] = useState<CanvasBox | null>(null);
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const [hires, setHires] = useState(false);
  const [dragKind, setDragKind] = useState<Drag["kind"] | null>(null);
  const [shift, setShift] = useState(false);
  // Alt держат — значит целятся вставить вершину. Показываем, куда она встанет:
  // не в курсор, а на грань, которую разделит. Иначе рука, промахнувшаяся мимо
  // контура, вывернула бы его и не поняла почему.
  const [alt, setAlt] = useState(false);
  const [insertAt, setInsertAt] = useState<
    // `at` — куда встанет точка (курсор), `a`/`b` — концы грани, которую она
    // разделит. Грань нужна не для того, чтобы посадить на неё точку, а чтобы
    // показать, какое ребро сейчас разойдётся: место человек выбирает сам, а
    // вот в какой промежуток кольца оно попадёт — решает геометрия.
    { part: number; edge: number; at: Point; a: Point; b: Point } | null
  >(null);
  // Контур, который рисуют прямо сейчас: точки уже поставлены, но кольцом он
  // ещё не стал. Живёт в холсте, а не у редактора: это состояние жеста.
  const [draft, setDraft] = useState<Ring>([]);
  // Куда тянется резинка от последней точки — чтобы будущее ребро было видно.
  const [ghost, setGhost] = useState<Point | null>(null);
  // Где кадр оказался на экране: разметка рисуется поверх, вне трансформа.
  const [rect, setRect] = useState<Rect>({ l: 0, t: 0, w: 0, h: 0 });

  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const lassoRef = useRef<CanvasBox | null>(null);
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    setView({ s: 1, x: 0, y: 0 });
    setHires(false);
  }, [imageId]);

  // Сменился кадр или инструмент — недорисованный контур бросаем. Он привязан
  // к кадру, на котором его начали, и переезд на соседний сделал бы из него
  // разметку не того кадра.
  useEffect(() => { setDraft([]); setGhost(null); }, [imageId, tool]);

  useEffect(() => { onScale?.(view.s); }, [view.s, onScale]);

  // Меряем после каждой отрисовки: зум и панорама двигают кадр, а разметка
  // должна идти следом. Сравнение с прежним значением обрывает цикл.
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

  // Замкнуть контур: кольцом он становится здесь, а что с ним делать — решает
  // редактор. Меньше трёх точек не замыкается, и это единственное правило,
  // которое рисование знает про фигуру.
  const closeDraft = useCallback(() => {
    const d = draftRef.current;
    if (!poly.canClose(d)) return;
    setDraft([]);
    setGhost(null);
    onPolygon?.(d);
  }, [onPolygon]);

  useImperativeHandle(ref, () => ({
    zoomBy(factor: number) {
      const box = stageRef.current?.getBoundingClientRect();
      if (box) zoomAt(box.left + box.width / 2, box.top + box.height / 2, factor);
    },
    fit() { setView({ s: 1, x: 0, y: 0 }); },
    closePolygon() { closeDraft(); },
    cancelPolygon() { setDraft([]); setGhost(null); },
    undoPoint() { setDraft((d) => d.slice(0, -1)); },
    drawing() { return draftRef.current.length > 0; },
  }), [zoomAt, closeDraft]);

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
  // окна, Alt+Tab), объект иначе продолжает ехать за курсором.
  useEffect(() => {
    function stop() { if (dragRef.current) finish(); }
    function onShift(e: KeyboardEvent) { setShift(e.shiftKey); setAlt(e.altKey); }
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

  // Клавиши рисования — пока контур не замкнут, и только тогда. Слушаем в
  // фазе перехвата и гасим событие: Escape у редактора значит «выйти», и
  // недорисованный контур обязан перехватить его раньше.
  useEffect(() => {
    if (!draft.length) return;
    function onKey(e: KeyboardEvent) {
      if (e.code === "Escape") { setDraft([]); setGhost(null); }
      else if (e.code === "Enter" || e.code === "NumpadEnter") closeDraft();
      else if (e.code === "Backspace" || e.code === "Delete") {
        setDraft((d) => d.slice(0, -1));
      } else return;
      e.preventDefault();
      e.stopPropagation();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [draft.length, closeDraft]);

  useEffect(() => { if (!alt) setInsertAt(null); }, [alt]);

  function toImage(e: { clientX: number; clientY: number }) {
    const box = frameRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - box.left) / box.width) * width,
      y: ((e.clientY - box.top) / box.height) * height,
    };
  }

  function begin(e: ReactPointerEvent, d: Drag) {
    stageRef.current?.setPointerCapture(e.pointerId);
    dragRef.current = d;
    setDragKind(d.kind);
  }

  // Порог попадания — всегда HIT экранных пикселей, сколько бы ни было зума.
  const grab = useMemo(
    () => toImageDistance(HIT, width, height, rect),
    [width, height, rect]
  );

  function addPoint(p: Point) {
    // Клик по начальной точке — просьба замкнуть. Пока точек меньше трёх,
    // замыкать нечего, и клик просто не считается новой точкой: ставить
    // вторую поверх первой человек не хотел.
    if (poly.closesRing(draftRef.current, p, grab)) {
      if (poly.canClose(draftRef.current)) closeDraft();
      return;
    }
    setDraft((d) => [...d, p]);
  }

  /** Поставить вершину туда, где её показывает подсказка. Возвращает `true`,
   *  если вставка случилась — тогда нажатие больше ни во что не превращается. */
  function insertHere(): boolean {
    if (!insertAt || selected === null) return false;
    const s0 = boxesRef.current[selected];
    if (!s0?.parts?.length) return false;
    // Точка встаёт туда, куда показали, а в кольцо ложится между концами
    // ближайшей грани: место — за человеком, порядок — за геометрией.
    const parts = poly.insertVertex(s0.parts, insertAt.part, insertAt.edge, insertAt.at);
    const next = [...boxesRef.current];
    next[selected] = { ...s0, parts, ...(poly.bounds(parts) || {}) };
    onBoxes?.(next);
    setInsertAt(null);
    return true;
  }

  function onStageDown(e: ReactPointerEvent<HTMLDivElement>) {
    // Alt — «вставить вершину». Проверяем раньше всего: под ним нажатие не
    // рисует, не выделяет и не панорамит.
    if (e.button === 0 && e.altKey && editable && insertHere()) {
      e.preventDefault();
      return;
    }
    // Shift плюс правая кнопка — «этого участка в объекте нет». Только в
    // режиме точек: в режиме области уточнять нечем, там работает рамка.
    if (e.button === 2 && auto && autoMode === "points" && editable && e.shiftKey) {
      e.preventDefault();
      onAutoPoint?.(toImage(e), { shift: true, negative: true, onBox: null });
      return;
    }
    if (e.button !== 0) return;
    // Гасим нативный drag и выделение текста: именно они рождают призрак.
    e.preventDefault();
    if (auto && editable) {
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
    if (tool === "polygon" && activeClass !== null) {
      const p = toImage(e);
      addPoint([p.x, p.y]);
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
    // Резинка до курсора: без неё не видно, каким получится следующее ребро.
    if (draftRef.current.length && !dragRef.current) {
      const p = toImage(e);
      setGhost([p.x, p.y]);
    }
    // Где встанет вершина по Alt. Ищем только в выбранном объекте — и, когда
    // части выделяются по отдельности, только в выбранной его части: чужая
    // грань не должна перехватывать вставку, даже если она ближе.
    if (alt && !dragRef.current && editable && selected !== null) {
      const s0 = boxesRef.current[selected];
      const p = toImage(e);
      const near = s0?.parts?.length
        ? poly.nearestEdge(s0.parts, [p.x, p.y], splitParts ? selectedPart : null)
        : null;
      const ring = near ? s0!.parts![near.part] : null;
      setInsertAt(
        near && ring
          ? {
              part: near.part,
              edge: near.edge,
              // Точка встаёт туда, куда показывают, а не на грань: контур
              // правят, чтобы он повторил край объекта, и проекция на прямую
              // между старыми вершинами возвращала бы его ровно туда, откуда
              // его тянут.
              at: [
                Math.max(0, Math.min(p.x, width)),
                Math.max(0, Math.min(p.y, height)),
              ],
              a: ring[near.edge],
              b: ring[(near.edge + 1) % ring.length],
            }
          : null
      );
    }
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

    if (d.kind === "vertex") {
      const parts = poly.moveVertex(b.parts || [], d.part, d.vertex, [
        Math.max(0, Math.min(p.x, width)),
        Math.max(0, Math.min(p.y, height)),
      ]);
      next[d.i] = { ...b, parts, ...(poly.bounds(parts) || {}) };
      onBoxes?.(next);
      return;
    }
    if (d.kind === "new") {
      next[d.i] = clampBox(
        { ...b, x: d.x0, y: d.y0, w: p.x - d.x0, h: p.y - d.y0 }, width, height
      ) as CanvasShape;
    } else if (d.kind === "move") {
      // Упираем позицию, а не режем размер: у края объект должен вставать,
      // а не сжиматься — размер человек уже подобрал.
      const whole = boundsOf(b);
      // Когда тянут одну часть, упор считается по её собственной рамке:
      // иначе часть вставала бы у края по чужому размеру.
      const box =
        d.part !== null && b.parts?.[d.part]
          ? poly.bounds([b.parts[d.part]]) || whole
          : whole;
      const x = Math.max(0, Math.min(p.x - d.dx, width - box.w));
      const y = Math.max(0, Math.min(p.y - d.dy, height - box.h));
      if (isPoly(b)) {
        const dx = x - box.x;
        const dy = y - box.y;
        const parts =
          d.part !== null
            ? b.parts!.map((ring, k) =>
                k === d.part ? poly.moveParts([ring], dx, dy)[0] : ring
              )
            // Весь объект — всеми частями: половина, оставшаяся на месте,
            // разорвала бы то, что человек считает одним.
            : poly.moveParts(b.parts!, dx, dy);
        next[d.i] = { ...b, parts, ...(poly.bounds(parts) || {}) };
      } else {
        next[d.i] = { ...b, x, y };
      }
    } else {
      // Рамкой тянут только бокс. У контура рамка — показание, а не орган
      // управления: тянуть её значило бы масштабировать все точки разом, а
      // правят контур по вершинам.
      let { x, y, w, h } = b;
      if (d.corner.includes("l")) { w += x - p.x; x = p.x; }
      if (d.corner.includes("r")) { w = p.x - x; }
      if (d.corner.includes("t")) { h += y - p.y; y = p.y; }
      if (d.corner.includes("b")) { h = p.y - y; }
      next[d.i] = clampBox({ ...b, x, y, w, h }, width, height) as CanvasShape;
    }
    onBoxes?.(next);
  }

  const cursor = dragKind === "pan"
    ? "grabbing"
    : waiting ? "wait"
    : auto && editable ? "auto"
    : shift || !editable ? "pan"
    : tool === "box" || tool === "polygon" ? "draw" : "pick";

  const sx = useCallback(
    (x: number, y: number) => toScreen(x, y, width, height, rect),
    [width, height, rect]
  );

  /** Кольца объекта в экранных координатах, одной строкой пути. */
  function ringsPath(parts: Ring[]): string {
    return parts
      .map((ring) => {
        const head = sx(ring[0][0], ring[0][1]);
        const rest = ring.slice(1).map(([x, y]) => {
          const [px, py] = sx(x, y);
          return `L${px} ${py}`;
        });
        return `M${head[0]} ${head[1]}${rest.join("")}Z`;
      })
      .join("");
  }

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
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}
      >
        <div className="mag-cv-frame" ref={frameRef}>
          {bitmap !== undefined ? (
            <BitmapView
              bitmap={bitmap}
              width={width}
              height={height}
              maxHeight={`calc(100vh - ${reserve}px)`}
            />
          ) : (
            <img
              src={src || imagePreviewUrl(imageId)}
              alt={fileName || ""}
              draggable={false}
              style={{ maxHeight: `calc(100vh - ${reserve}px)` }}
            />
          )}
          {/* Оригинал приезжает вторым слоем: подмена src дала бы моргание.
              У кадра видео второго размера нет — слой не нужен. */}
          {hires && !src && bitmap === undefined && (
            <img className="mag-cv-hires" src={imageFileUrl(imageId)} alt="" draggable={false} />
          )}
        </div>
      </div>

      {/* Разметка целиком: объекты, якоря, вершины, подсказки модели. Слой не
          ловит события сам — их ловят только нарисованные в нём фигуры, иначе
          он забрал бы у сцены панораму. */}
      <svg
        className={"mag-cv-layer" + (alt && editable ? " alt" : "")}
        width="100%"
        height="100%"
      >
        {boxes.map((s, i) => {
          if (hidden?.has(s.class_index)) return null;
          const meta = labelOf(s.class_index);
          const on = i === selected;
          const box = boundsOf(s);
          const [px, py] = sx(box.x, box.y);
          const [px2, py2] = sx(box.x + box.w, box.y + box.h);
          const sw = px2 - px;
          const sh = py2 - py;
          const contour = isPoly(s);
          const cls =
            "mag-cv-sh" + (contour ? " poly" : "") + (on ? " on" : "") +
            (dashed?.has(i) ? " occluded" : "");
          // Рамка одна и та же в покое и в выборе: объект не должен менять
          // форму от того, что на него нажали. Отличают его заливка и вес
          // линии, а не силуэт.
          const outline = contour
            ? ringsPath(s.parts!)
            : `M${px} ${py}H${px2}V${py2}H${px}Z`;
          const { corners, mids } = affordance(sw, sh);
          const vertices =
            contour && on && editable && showVertices(s.parts!, width, height, rect);

          function menu(
            e: ReactPointerEvent | React.MouseEvent,
            at?: { part?: number; vertex?: number }
          ) {
            if (!editable || !onContext) return;
            e.preventDefault();
            e.stopPropagation();
            // Shift+правая в полуавтомате — «убрать этот участок», точку уже
            // поставил обработчик холста; меню тут лишнее.
            if (auto && (e as React.MouseEvent).shiftKey) return;
            onSelect?.(i, at?.part ?? null);
            onContext(
              i,
              (e as React.MouseEvent).clientX,
              (e as React.MouseEvent).clientY,
              at
            );
          }

          function down(e: ReactPointerEvent, part: number) {
            if (e.button !== 0) return;
            // Под Alt объект не подхватывают: нажатие уходит на сцену и
            // становится новой вершиной.
            if (e.altKey && editable) return;
            // В режиме контура готовые объекты кликов не перехватывают вовсе:
            // точку ставят и поверх них, в том числе первую. Событие уходит на
            // сцену нетронутым — иначе объект начал бы переезжать вместо того,
            // чтобы под ним появилась вершина.
            if (tool === "polygon" && editable && !auto) return;
            if (!auto) onSelect?.(i, part);
            // В полуавтомате объект не таскают: Shift по нему — «доуточни вот
            // этот», обычный клик — начало нового. В режиме области событие
            // уходит на холст: рамку рисуют и поверх готовых объектов.
            if (auto && editable) {
              if (autoMode !== "points") return;
              e.preventDefault();
              e.stopPropagation();
              // Выбор меняем только при подхвате: иначе обычный клик забирал
              // бы выделение, а Delete удалял не то.
              if (e.shiftKey) onSelect?.(i, part);
              const p = toImage(e);
              onAutoPoint?.(p, { shift: e.shiftKey, negative: false, onBox: i });
              return;
            }
            // В просмотре объект только выбирается, а протяжка панорамит:
            // событие нарочно уходит дальше на холст.
            if (!editable || e.shiftKey) return;
            e.preventDefault();
            e.stopPropagation();
            // Контуры не двигаются, пока это не разрешили: промах мимо
            // вершины уводил бы всю обводку с объекта, к которому её
            // подгоняли. Выделение при этом уже случилось — клик не пропал.
            if (contour && !canMovePoly) return;
            const p = toImage(e);
            // За какую часть взялись, ту и тянем — если тумблер разрешает.
            // Иначе `part` нужен только меню, где «убрать этот контур»
            // относится именно к нему.
            const grip =
              splitParts && contour && s.parts![part] ? part : null;
            const from =
              grip !== null ? poly.bounds([s.parts![grip]]) || box : box;
            begin(e, { kind: "move", i, part: grip, dx: p.x - from.x, dy: p.y - from.y });
          }

          return (
            <g key={i} className={cls} style={{ ["--bc" as string]: meta.color }}>
              {/* Тело: ловит клик и ничего не рисует. У контура это его форма,
                  причём **каждая часть своей фигурой** — по ней часть и
                  выделяется отдельно от соседних. У бокса — прямоугольник. */}
              {contour ? (
                s.parts!.map((_, part) => (
                  <path
                    key={part}
                    className={
                      "mag-cv-hit" +
                      (on && splitParts && part === selectedPart ? " part-on" : "")
                    }
                    d={ringsPath([s.parts![part]])}
                    onPointerDown={(e) => down(e, part)}
                    onContextMenu={(e) => menu(e, { part })}
                  />
                ))
              ) : (
                <rect
                  className="mag-cv-hit"
                  x={px} y={py} width={Math.max(sw, 0)} height={Math.max(sh, 0)}
                  onPointerDown={(e) => down(e, 0)}
                  onContextMenu={(e) => menu(e)}
                />
              )}
              {/* Габарит контура: пунктирная рамка по самым крайним точкам
                  объекта — всех его частей сразу. Сам контур при этом сплошной.
                  Так видно и точную форму, и место, которое объект занимает,
                  а у разорванного объекта — что половины принадлежат одному
                  целому, даже когда между ними полкадра. */}
              {contour && (
                <rect
                  className="mag-cv-cage"
                  x={px} y={py}
                  width={Math.max(sw, 0)} height={Math.max(sh, 0)}
                />
              )}
              {/* Двойная обводка: тёмная под цветной. Иначе рамка теряется то
                  на белом небе, то на чёрном вагоне. */}
              <path className="mag-cv-hull" d={outline} />
              <path className="mag-cv-line" d={outline} />
              {/* Выделенная часть обводится поверх общей линии: у объекта из
                  двух половин надо видеть, которую сейчас потянут. */}
              {contour && on && splitParts && selectedPart !== null &&
                s.parts![selectedPart] && (
                  <path
                    className="mag-cv-part"
                    d={ringsPath([s.parts![selectedPart]])}
                  />
                )}

              {/* Якоря выбранного бокса. */}
              {on && editable && !contour && corners &&
                HANDLES.filter((c) => mids || CORNERS.has(c)).map((corner) => {
                  const hx = corner.includes("l") ? px : corner.includes("r") ? px2 : (px + px2) / 2;
                  const hy = corner.includes("t") ? py : corner.includes("b") ? py2 : (py + py2) / 2;
                  return (
                    <rect
                      key={corner}
                      className={`mag-cv-h ${corner}`}
                      x={hx - HIT / 2} y={hy - HIT / 2} width={HIT} height={HIT}
                      onPointerDown={(e) => {
                        if (e.button !== 0 || e.shiftKey) return;
                        e.preventDefault();
                        e.stopPropagation();
                        begin(e, { kind: "resize", i, corner });
                      }}
                    />
                  );
                })}

              {/* Вершины контура — ромбы, тем же знаком, что ключи в дорожках
                  треков: «это поставил человек». Убрать вершину — правой
                  кнопкой: Alt занят вставкой, и один модификатор не может
                  значить и «добавить», и «убрать». */}
              {vertices && s.parts!.map((ring, part) =>
                ring.map(([vx, vy], vertex) => {
                  const [cx, cy] = sx(vx, vy);
                  const dim = splitParts && selectedPart !== null && part !== selectedPart;
                  return (
                    <path
                      key={`${part}-${vertex}`}
                      className={dim ? "mag-cv-v dim" : "mag-cv-v"}
                      d={diamond(cx, cy, VERTEX_R)}
                      onPointerDown={(e) => {
                        if (e.button !== 0 || e.shiftKey || e.altKey) return;
                        e.preventDefault();
                        e.stopPropagation();
                        onSelect?.(i, part);
                        begin(e, { kind: "vertex", i, part, vertex });
                      }}
                      onContextMenu={(e) => menu(e, { part, vertex })}
                    />
                  );
                })
              )}

              {/* Куда встанет вершина под Alt — прямо под курсором. Усы к
                  концам грани показывают, какое ребро при этом разойдётся:
                  место выбирает человек, промежуток кольца — геометрия.
                  Подсказка событий не ловит, нажатие обрабатывает сцена. */}
              {on && alt && insertAt && editable && (() => {
                const [cx, cy] = sx(insertAt.at[0], insertAt.at[1]);
                const [ax, ay] = sx(insertAt.a[0], insertAt.a[1]);
                const [bx, by] = sx(insertAt.b[0], insertAt.b[1]);
                return (
                  <>
                    <path
                      className="mag-cv-new-edge"
                      d={`M${ax} ${ay}L${cx} ${cy}L${bx} ${by}`}
                    />
                    <path className="mag-cv-new" d={diamond(cx, cy, 8)} />
                  </>
                );
              })()}
            </g>
          );
        })}

        {/* Контур, который рисуют. Начальная точка выделена: в неё и целятся,
            чтобы замкнуть. */}
        {draft.length > 0 && (() => {
          // Черновик носит цвет своего класса, а не служебный жёлтый: человек
          // выбирает класс до того, как начнёт обводить, и должен видеть, что
          // обводит именно его. Отличает черновик от готового объекта пунктир
          // и открытый конец, а не чужой цвет.
          const meta = labelOf(activeClass ?? -1);
          const path =
            `M${sx(draft[0][0], draft[0][1]).join(" ")}` +
            draft.slice(1).map((p) => `L${sx(p[0], p[1]).join(" ")}`).join("") +
            (ghost ? `L${sx(ghost[0], ghost[1]).join(" ")}` : "");
          // Курсор подошёл к началу и точек уже хватает — начальная точка
          // растёт навстречу. Иначе «куда нажать, чтобы замкнуть» приходится
          // угадывать по памяти.
          const closing =
            !!ghost && poly.canClose(draft) && poly.closesRing(draft, ghost, grab);
          return (
            <g className="mag-cv-draft" style={{ ["--bc" as string]: meta.color }}>
              {/* Тёмной подложки у черновика нет. Под пунктиром она видна в
                  каждом промежутке, и линия читается как чередование цвета
                  класса с чёрным — то есть как два цвета вместо одного. */}
              <path className="mag-cv-line" d={path} />
              {draft.map((p, k) => {
                const [cx, cy] = sx(p[0], p[1]);
                const first = k === 0;
                return (
                  <path
                    key={k}
                    className={
                      "mag-cv-v" + (first ? " first" : "") +
                      (first && closing ? " near" : "")
                    }
                    d={diamond(cx, cy, first ? (closing ? 12 : 9) : VERTEX_R)}
                  />
                );
              })}
            </g>
          );
        })()}

        {/* Выделение области под подсказку модели. */}
        {lasso && (
          <rect
            className="mag-cv-lasso"
            x={sx(lasso.x, lasso.y)[0]}
            y={sx(lasso.x, lasso.y)[1]}
            width={(lasso.w / width) * rect.w}
            height={(lasso.h / height) * rect.h}
          />
        )}

        {/* Предварительная детекция: контур того, что модель сочла объектом,
            и рамка вокруг. По одной рамке не понять, то ли она схватила. */}
        {autoPreview && (
          <g className="mag-cv-pre" style={{ ["--bc" as string]: autoPreview.color }}>
            <rect
              x={sx(autoPreview.x, autoPreview.y)[0]}
              y={sx(autoPreview.x, autoPreview.y)[1]}
              width={(autoPreview.w / width) * rect.w}
              height={(autoPreview.h / height) * rect.h}
            />
            {!!autoPreview.polygons?.length && (
              <path
                className="mag-cv-mask"
                d={ringsPath(autoPreview.polygons.filter((r) => r.length > 2) as Ring[])}
              />
            )}
          </g>
        )}

        {/* Точки-подсказки: сплошная — объект здесь, полая — здесь его нет. */}
        {autoPoints?.map((p, i) => {
          const [cx, cy] = sx(p.x, p.y);
          return (
            <circle
              key={i}
              className={p.label ? "mag-cv-pt" : "mag-cv-pt neg"}
              cx={cx} cy={cy} r={5}
            />
          );
        })}
      </svg>

      {/* Подписи — обычным текстом поверх сцены: в SVG он потребовал бы своей
          вёрстки плашки, а здесь она уже есть. */}
      {labels && (
        <div className="mag-cv-labels">
          {boxes.map((s, i) => {
            if (hidden?.has(s.class_index)) return null;
            const meta = labelOf(s.class_index);
            const box = boundsOf(s);
            const [px, py] = sx(box.x, box.y);
            return (
              <span
                key={i}
                className="mag-cv-lb"
                style={{ left: px, top: py, background: meta.color }}
              >
                {meta.name || s.class_index}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
});

export default BoxCanvas;
