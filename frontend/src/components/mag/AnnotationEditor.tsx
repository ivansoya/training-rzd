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
import type {
  CanvasHandle, CanvasPoint, CanvasPreview, CanvasShape,
} from "./BoxCanvas";
import * as poly from "./polygon";
import type { Ring } from "./polygon";
import ClassMenu from "./ClassMenu";
import FilmStrip from "./FilmStrip";
import { useAutoLabel } from "./useAutoLabel";
import type { AutoRefine } from "../../auth/api";

/** Управление редактором: клавиша и что она делает.
 *
 * Тот же приём, что в разметчике видео, и по той же причине: один список на две
 * задачи — подсветку самого элемента и панель со всеми сочетаниями. Держать их
 * порознь значило бы, что однажды они разойдутся и подсказка начнёт врать про
 * клавишу.
 *
 * Краткие названия видны на панели инструментов, подробные сочетания —
 * в справке и в подсказках при включённом режиме справки.
 */
const HELP = {
  close: ["Esc", "Выйти из разметки"],
  select: ["V", "Выбор и правка"],
  box: ["B", "Рамка. Ещё раз B — залипание, рисовать подряд"],
  polygon: ["P", "Контур. Замкнуть — клик по первой точке или Enter"],
  polyOpts: ["", "Настройки контура: двигать ли его и части по отдельности"],
  auto: ["A", "Полуавтомат: обвести объект по клику"],
  autoOpts: ["", "Параметры полуавтомата"],
  addPart: ["⇧P", "Следующий контур ляжет в выбранный объект"],
  vertex: ["Alt", "Новая точка контура под курсором"],
  del: ["Del", "Удалить объект, а при раздельных частях — часть"],
  cls: ["1–9", "Класс для новых объектов"],
  empty: ["E", "Кадр фоновый: объектов на нём нет"],
  skip: ["S", "Отложить кадр"],
  trash: ["X", "Забраковать кадр"],
  next: ["Пробел", "Следующий кадр"],
  step: ["← →", "Предыдущий и следующий кадр"],
  zoomIn: ["", "Приблизить"],
  zoomOut: ["", "Отдалить"],
  fit: ["0", "Вписать кадр в окно"],
  grid: ["", "Сетка на фоне"],
  pan: ["Shift + протяжка", "Двигать полотно. Колесо — зум"],
  strip: ["", "Кинолента таски. Потяните верхнюю кромку — изменить высоту"],
} as const;

type HelpId = keyof typeof HELP;

/** Разметить элемент для справки: подсветится и покажет свою подсказку. */
function hk(id: HelpId) {
  const [key, text] = HELP[id];
  return { "data-hk": key || undefined, "data-ht": text, "data-help": "" };
}

const GREY = { name: "", color: "#9aa4ae" };

/** Бокс как кольцо из четырёх точек.
 *
 * Нужен, когда бокс присоединяют к объекту-контуру: объект после этого целиком
 * полигональный, и его прямоугольная часть — честная запись того, что человек
 * нарисовал рамкой. Обратно бокс уже не превратится, и это не потеря: рамка
 * из четырёх точек и есть рамка.
 */
function boxRing(b: { x: number; y: number; w: number; h: number }): Ring {
  return [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h],
  ];
}

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
  const [boxes, setBoxes] = useState<CanvasShape[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  // Какая часть выбранного объекта под рукой. У разорванного вагона половины
  // лежат в разных местах кадра, и «подвинуть объект» — не то же, что
  // «подвинуть эту половину».
  const [selPart, setSelPart] = useState<number | null>(null);
  // Тумблеры живут в настройках контура: они про привычку человека, а не про
  // состояние холста, и переживают переключение инструментов.
  //
  // Двигать контуры по умолчанию **нельзя**. Контур правят по вершинам, а
  // перенос целиком нужен редко и случается легко: промахнулся мимо вершины,
  // повёл мышь — и вся обводка уехала с объекта, к которому её подгоняли.
  // Отменить это нечем, кроме как обвести заново.
  const [canMovePoly, setCanMovePoly] = useState(false);
  const [splitParts, setSplitParts] = useState(false);
  const [polyPanel, setPolyPanel] = useState(false);
  // Инструмент говорит, ЧТО получится: рамка или контур. Полуавтомат — не
  // четвёртый инструмент, а способ ввода поверх текущего, и живёт отдельным
  // тумблером: «полуавтоматом по контурам» выражается двумя клавишами, а не
  // новым режимом.
  const [tool, setTool] = useState<"select" | "box" | "polygon">("select");
  // Полуавтомат — не режим, а привычка: включив его однажды, к нему не
  // возвращаются. Поэтому переключение инструментов его **не сбрасывает** —
  // иначе на каждый переход «рамка → контур» приходилось бы включать заново.
  // В «выборе» он просто ничего не делает: рисовать там нечем.
  const [autoOn, setAutoOn] = useState(false);
  const [lock, setLock] = useState(false);
  // Объект, к которому присоединится следующий замкнутый контур. Пусто —
  // контур станет новым объектом.
  const [addTo, setAddTo] = useState<number | null>(null);
  // Полуавтомат: набор точек и ещё не закреплённая детекция.
  const [autoMode, setAutoMode] = useState<"points" | "box">("points");
  const [autoPts, setAutoPts] = useState<CanvasPoint[]>([]);
  const [autoPrev, setAutoPrev] = useState<CanvasPreview | null>(null);
  const [autoPrompt, setAutoPrompt] = useState<CanvasShape | null>(null);
  // Индекс бокса, который сейчас уточняем: на закреплении он заменяется.
  const [replacing, setReplacing] = useState<number | null>(null);
  const [autoPanel, setAutoPanel] = useState(false);
  const [refine, setRefine] = useState<AutoRefine>({
    detail: "auto", score_min: 0.3, min_area: 64, fill_holes: true, polygon_points: 64,
  });
  // Что делать после закрепления: взяться за следующий объект или выйти в выбор.
  const [afterCommit, setAfterCommit] = useState<"new" | "select">("new");
  // i === null — меню открыто на плашке активного класса, а не на детекции.
  // `prev` — что было выбрано ДО правой кнопки: она сама меняет выделение, а
  // «присоединить к выбранному» относится к прежнему объекту, не к этому.
  const [menu, setMenu] = useState<{
    i: number | null;
    x: number;
    y: number;
    part?: number;
    vertex?: number;
    prev: number | null;
  } | null>(null);
  const pick = useCallback((i: number | null, part: number | null = null) => {
    setSelected(i);
    setSelPart(i === null ? null : part);
  }, []);

  const [scale, setScale] = useState(1);
  const [filmH, setFilmH] = useState(164);
  const [saved, setSaved] = useState(true);
  const [grid, setGrid] = useState(true);
  const [help, setHelp] = useState(false);
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
        ...(b.kind === "polygon" && b.parts?.length
          ? { kind: "polygon" as const, parts: b.parts }
          : {}),
      }))
    );
    setAddTo(null);
    setSelected(null);
    setSelPart(null);
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

  const edit = useCallback((next: CanvasShape[]) => {
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

  /** Нажатие на инструмент: повторное нажатие включает залипание — им рисуют
   *  подряд, не возвращаясь в выбор после каждого объекта. */
  const pickTool = useCallback((want: "box") => {
    setTool((t) => {
      if (t === want) { setLock((l) => !l); return t; }
      setLock(false);
      return want;
    });
    setAddTo(null);
  }, []);


  // --- полуавтоматическая разметка ---------------------------------------- #

  const auto = useAutoLabel(
    image ? { image_id: image.id } : null,
    images[index + 1] ? { image_id: images[index + 1].id } : null
  );

  /** Работает ли полуавтомат прямо сейчас. В «выборе» рисовать нечем, но сам
   *  тумблер при этом не гаснет — он запомнен. */
  const autoLive = autoOn && tool !== "select" && auto.state === "ready";

  const clearAuto = useCallback(() => {
    setAutoPts([]);
    setAutoPrev(null);
    setAutoPrompt(null);
    setReplacing(null);
  }, []);

  // Кадр сменился — начатое выделение к нему не относится.
  useEffect(() => { clearAuto(); }, [image?.id, clearAuto]);

  const ask = useCallback(
    async (points: CanvasPoint[], prompt: CanvasShape | null) => {
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

  /** Закрепление: детекция становится обычным объектом, как все остальные.
   *
   *  Чем именно — решает инструмент. Модель отдаёт и рамку, и куски маски
   *  сразу, поэтому вопрос «а полигоном?» не задаётся: включён контур —
   *  закрепляются все куски одним объектом, включён бокс — рамка.
   */
  const commitAuto = useCallback(() => {
    if (!autoPrev || active === null) return;
    const rings = (autoPrev.polygons || []).filter((r) => r.length >= poly.MIN_POINTS);
    const shape: CanvasShape =
      tool === "polygon" && rings.length
        ? {
            class_index: active,
            kind: "polygon",
            parts: rings as Ring[],
            ...(poly.bounds(rings as Ring[]) || autoPrev),
          }
        : {
            class_index: active,
            x: autoPrev.x, y: autoPrev.y, w: autoPrev.w, h: autoPrev.h,
          };
    if (replacing !== null && boxes[replacing]) {
      edit(boxes.map((b, i) => (i === replacing ? shape : b)));
      setSelected(replacing);
    } else {
      edit([...boxes, shape]);
      setSelected(boxes.length);
    }
    clearAuto();
  }, [autoPrev, active, replacing, boxes, edit, clearAuto, tool]);

  /** Замкнули контур руками: он либо новый объект, либо ещё одна часть того,
   *  к которому его просили присоединить. */
  const onPolygon = useCallback(
    (ring: Ring) => {
      if (frozen || active === null) return;
      const target = addTo !== null && boxes[addTo] ? addTo : null;
      if (target !== null) {
        const parts = [...(boxes[target].parts || []), ring];
        edit(boxes.map((b, i) =>
          i === target
            ? { ...b, kind: "polygon" as const, parts, ...(poly.bounds(parts) || {}) }
            : b
        ));
        setSelected(target);
        setSelPart(parts.length - 1);
        setTool("select");
        // Присоединение — разовая просьба, а не режим: иначе следующий контур
        // молча уехал бы в тот же объект.
        setAddTo(null);
        return;
      }
      const parts = [ring];
      edit([...boxes, {
        class_index: active, kind: "polygon" as const, parts,
        ...(poly.bounds(parts) || { x: 0, y: 0, w: 0, h: 0 }),
      }]);
      setSelected(boxes.length);
      setSelPart(0);
      // Замкнули — возвращаемся в выбор **всегда**, даже при залипании.
      // Готовый контур почти никогда не бывает готов с первого раза: следом
      // идёт правка, а не второй контур. Залипание осталось у рамки, где
      // объекты действительно рисуют подряд.
      setTool("select");
    },
    [frozen, active, addTo, boxes, edit]
  );

  /** Влить объект `from` в объект `into`: части складываются, донор исчезает. */
  const joinInto = useCallback(
    (from: number, into: number) => {
      const a = boxes[into];
      const b = boxes[from];
      if (!a || !b || from === into) return;
      if (a.class_index !== b.class_index) {
        setError("Соединять можно только объекты одного класса.");
        return;
      }
      const parts = [
        ...(a.parts || [boxRing(a)]),
        ...(b.parts || [boxRing(b)]),
      ];
      const next = boxes
        .map((s, i) =>
          i === into
            ? { ...a, kind: "polygon" as const, parts, ...(poly.bounds(parts) || {}) }
            : s
        )
        .filter((_, i) => i !== from);
      edit(next);
      // Индекс выбранного мог сдвинуться: донор стоял раньше приёмника.
      setSelected(into > from ? into - 1 : into);
    },
    [boxes, edit]
  );

  /** Убрать одну часть объекта. Последняя часть — это сам объект. */
  const dropPart = useCallback(
    (i: number, part: number) => {
      const s = boxes[i];
      if (!s?.parts?.length) return;
      if (s.parts.length <= 1) {
        edit(boxes.filter((_, k) => k !== i));
        setSelected(null);
        return;
      }
      const parts = poly.removePart(s.parts, part);
      edit(boxes.map((b, k) =>
        k === i ? { ...b, parts, ...(poly.bounds(parts) || {}) } : b
      ));
    },
    [boxes, edit]
  );

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

  /** Полуавтомат перпендикулярен инструменту. Включая его из выбора, встаём
   *  на бокс: рисовать он должен чем-то, а «чем» — это и есть инструмент. */
  const pickAuto = useCallback(() => {
    setAutoOn((v) => {
      if (!v) setTool((t) => (t === "select" ? "box" : t));
      return !v;
    });
    clearAuto();
  }, [clearAuto]);

  /** «Присоединить следующий контур к выбранному». Разовая просьба: холст
   *  переходит в рисование, и первый же замкнутый контур ляжет в объект. */
  const addContour = useCallback(() => {
    if (frozen || selected === null || !boxes[selected]) return;
    setAddTo(selected);
    setTool("polygon");
  }, [frozen, selected, boxes]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Клавиши молчат, пока человек печатает, — но флажок и ползунок это не
      // печать. Прежде любой <input> глушил инструменты, и после клика по
      // галке в панели V/B/P переставали работать до тех пор, пока не
      // щёлкнешь мимо: молчаливо и необъяснимо.
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const typing =
        tag === "TEXTAREA" ||
        (tag === "INPUT" &&
          !["checkbox", "radio", "range", "button", "submit"].includes(
            (el as HTMLInputElement).type
          ));
      if (typing || el?.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Shift+P — «присоединить контур к выбранному». Единственное сочетание с
      // Shift, поэтому проверяем его до общего разбора, а не заводим ветку.
      if (e.shiftKey) {
        if (e.code === "KeyP" && !frozen) { addContour(); e.preventDefault(); }
        return;
      }
      switch (e.code) {
        case "Escape":
          // Esc снимает начатое по одному слою за нажатие и только на дне
          // закрывает редактор. Недорисованный контур в этот список не входит:
          // его Escape холст перехватывает раньше, пока контур существует.
          if (autoPrev || autoPts.length) clearAuto();
          else if (addTo !== null) setAddTo(null);
          // Полуавтомат Esc не забывает: он запомнен, а не включён «сейчас».
          // Забыв его тут, мы заставили бы включать заново после каждого
          // выхода из инструмента — то есть постоянно.
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
        case "KeyV":
          setTool("select"); setLock(false); setAddTo(null);
          break;
        case "KeyB": if (!frozen) pickTool("box"); break;
        case "KeyP":
          // Без залипания: контур всё равно возвращает в выбор после
          // замыкания, и второе нажатие P только заводило бы флаг, который
          // ни на что не влияет.
          if (!frozen) { setTool("polygon"); setAddTo(null); }
          break;
        case "KeyA": if (!frozen && auto.state === "ready") pickAuto(); break;
        case "KeyE": if (!frozen) toggle("empty"); break;
        case "KeyS": if (!frozen) toggle("skipped"); break;
        case "KeyX": trash(); break;
        case "Digit0": canvas.current?.fit(); break;
        case "Delete":
        case "Backspace":
          // Delete — про разметку: удаляет выбранный объект. Незакреплённое
          // выделение снимает Esc, иначе до объектов было бы не добраться.
          // Когда части выделяются по отдельности, уходит выделенная часть —
          // человек указал на неё, а не на объект; последняя часть и есть
          // объект, и тогда уходит он.
          if (selected !== null && !frozen) {
            const me = boxes[selected];
            if (splitParts && selPart !== null && (me?.parts?.length || 0) > 1) {
              const parts = poly.removePart(me.parts!, selPart);
              edit(boxes.map((b, k) =>
                k === selected ? { ...b, parts, ...(poly.bounds(parts) || {}) } : b
              ));
              setSelPart(null);
            } else {
              edit(boxes.filter((_, i) => i !== selected));
              pick(null);
            }
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
  }, [go, flush, onClose, selected, selPart, splitParts, visible, tool, autoOn,
      addTo, frozen, pickTool, addContour, toggle, trash, boxes, edit, pick,
      pickClass, auto.state, pickAuto, autoPrev, autoPts, clearAuto, commitAuto]);

  /** Что можно сделать с объектом под правой кнопкой, кроме смены класса.
   *
   *  Действия появляются только когда им есть на чём сработать: пункт, который
   *  ничего не сделает, хуже отсутствующего — по нему нажимают и ждут. */
  function menuActions(m: {
    i: number | null;
    part?: number;
    vertex?: number;
    prev: number | null;
  }) {
    if (m.i === null || frozen) return undefined;
    const i = m.i;
    const me = boxes[i];
    if (!me) return undefined;
    const acts: { label: string; hint?: string; run: () => void }[] = [];

    acts.push({
      label: "Добавить контур",
      hint: "⇧P",
      run: () => {
        setSelected(i);
        setAddTo(i);
        setTool("polygon");
        setMenu(null);
      },
    });

    const into = m.prev;
    if (into !== null && into !== i && boxes[into]) {
      const same = boxes[into].class_index === me.class_index;
      acts.push({
        label: "Присоединить к выбранному",
        hint: same ? undefined : "другой класс",
        run: () => {
          if (same) joinInto(i, into);
          else setError("Соединять можно только объекты одного класса.");
          setMenu(null);
        },
      });
    }

    if (m.vertex !== undefined && m.part !== undefined && me.parts) {
      const ring = me.parts[m.part];
      const last = !ring || ring.length <= poly.MIN_POINTS;
      acts.push({
        label: "Убрать точку",
        hint: last ? `нельзя: осталось ${poly.MIN_POINTS}` : undefined,
        run: () => {
          if (!last) {
            const parts = poly.removeVertex(me.parts!, m.part!, m.vertex!);
            edit(boxes.map((b, k) =>
              k === i ? { ...b, parts, ...(poly.bounds(parts) || {}) } : b
            ));
          }
          setMenu(null);
        },
      });
    }

    if (me.parts && me.parts.length > 1 && m.part !== undefined) {
      acts.push({
        label: "Убрать этот контур",
        hint: `останется ${me.parts.length - 1}`,
        run: () => { dropPart(i, m.part as number); setMenu(null); },
      });
    }
    return acts;
  }

  if (!image) return null;

  const isEmpty = image.task_status === "empty";
  const isSkipped = image.task_status === "skipped";
  const isDeleted = image.task_status === "deleted";

  return (
    <div
      className={help ? "mag-ed help" : "mag-ed"}
      role="dialog" aria-modal="true" aria-label="Разметка"
    >
      <div className="mag-ed-head">
        <b>{taskName}</b>
        <span className="mag-ed-cnt">кадр {index + 1} из {images.length}</span>
        {/* Класс, который получат новые объекты. В списке справа он тоже
            подсвечен, но глаз при разметке смотрит не туда. */}
        {active !== null && (
          <button
            type="button"
            className={autoOn ? "mag-ed-active on" : "mag-ed-active"}
            {...hk("cls")}
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMenu({ i: null, x: r.left, y: r.bottom + 6, prev: selected });
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
            {...hk("empty")}
          >
            Пусто
          </button>
          <button
            className={isSkipped ? "mag-ed-btn warn on" : "mag-ed-btn warn"}
            type="button"
            disabled={frozen}
            onClick={() => toggle("skipped")}
            {...hk("skip")}
          >
            Отложить
          </button>
          <button
            className={isDeleted ? "mag-ed-btn del on" : "mag-ed-btn del"}
            type="button"
            disabled={readOnly}
            onClick={trash}
            {...hk("trash")}
          >
            {isDeleted ? "Вернуть" : "Удалить"}
          </button>
          <button
            className="mag-ed-btn primary"
            type="button"
            onClick={() => go(1)}
            {...hk("next")}
          >
            Далее →
          </button>
        </span>
        <button
          className={help ? "mag-ed-btn on" : "mag-ed-btn"}
          type="button"
          onClick={() => setHelp((v) => !v)}
          aria-pressed={help}
        >
          справка
        </button>
        <button
          className="mag-ed-btn"
          type="button"
          onClick={() => flush().then(onClose)}
          aria-label="Закрыть"
          {...hk("close")}
        >
          ✕
        </button>
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

      <div className="mag-ed-body">
        {/* Рейк: только вид и инструменты, решений по кадру здесь нет */}
        <div className="mag-ed-rail">
          <button
            className={tool === "select" ? "mag-tool on" : "mag-tool"}
            type="button"
            onClick={() => { setTool("select"); setLock(false); setAddTo(null); }}
            {...hk("select")}
          >
            <span>V</span><small>Выбор</small>
          </button>
          <button
            className={tool === "box" ? "mag-tool on" : "mag-tool"}
            type="button"
            disabled={frozen}
            onClick={() => pickTool("box")}
            {...hk("box")}
          >
            <span>B</span><small>Бокс</small>
            {tool === "box" && lock && <i className="mag-tool-lock" />}
          </button>
          <button
            className={tool === "polygon" ? "mag-tool on" : "mag-tool"}
            type="button"
            disabled={frozen}
            onClick={() => { setTool("polygon"); setAddTo(null); }}
            {...hk("polygon")}
          >
            <span>P</span><small>Контур</small>
          </button>
          {tool === "polygon" && (
            <button
              className={polyPanel ? "mag-tool on" : "mag-tool"}
              type="button"
              onClick={() => setPolyPanel((v) => !v)}
              {...hk("polyOpts")}
            >
              <span>⚙</span><small>Контур</small>
            </button>
          )}
          {/* Полуавтомат стоит за чертой: он не четвёртый инструмент, а способ
              ввода поверх текущего. До готовности модели кнопка приглушена и
              пульсирует — первый подъём весов занимает десятки секунд. */}
          <hr />
          <button
            className={
              (autoOn ? "mag-tool on" : "mag-tool") +
              (auto.state === "starting" ? " warming" : "")
            }
            type="button"
            disabled={frozen || auto.state !== "ready"}
            onClick={pickAuto}
            {...hk("auto")}
            // Всплывашка остаётся только у неготовой кнопки, и это не
            // подсказка, а диагноз: почему на неё нельзя нажать. Справка
            // такого сказать не может — она про замысел, а не про состояние.
            title={
              auto.state === "ready"
                ? undefined
                : auto.state === "error"
                  ? `Модель недоступна: ${auto.error || "неизвестная ошибка"}`
                  : "Модель готовится…"
            }
          >
            <span>A</span><small>SAM2</small>
          </button>
          {autoOn && (
            <button
              className={autoPanel ? "mag-tool on" : "mag-tool"}
              type="button"
              onClick={() => setAutoPanel((v) => !v)}
              {...hk("autoOpts")}
            >
              <span>⚙</span><small>SAM2</small>
            </button>
          )}
          <hr />
          <button className="mag-tool" type="button" {...hk("zoomIn")}
            onClick={() => canvas.current?.zoomBy(1.3)}>
            <span>+</span><small>Зум</small>
          </button>
          <button className="mag-tool" type="button" {...hk("zoomOut")}
            onClick={() => canvas.current?.zoomBy(1 / 1.3)}>
            <span>−</span><small>Зум</small>
          </button>
          <button className="mag-tool wide" type="button" {...hk("fit")}
            onClick={() => canvas.current?.fit()}>
            {Math.round(scale * 100)}%
          </button>
          <hr />
          <button
            className={grid ? "mag-tool on" : "mag-tool"}
            type="button"
            onClick={() => setGrid((g) => !g)}
            {...hk("grid")}
          >
            <span>▦</span><small>Сетка</small>
          </button>
        </div>

        {/* Настройки контура. Тумблер здесь, а двигают части в «выборе»: это
            привычка человека, а не режим — заведя её однажды, к ней не
            возвращаются. */}
        {tool === "polygon" && polyPanel && (
          <div className="mag-auto-panel">
            <h5>Контур</h5>
            <label className="mag-auto-check">
              <input
                type="checkbox"
                checked={canMovePoly}
                onChange={(e) => {
                  setCanMovePoly(e.target.checked);
                  if (!e.target.checked) setSplitParts(false);
                }}
              />
              <span>Двигать контуры</span>
            </label>
            <label className={canMovePoly ? "mag-auto-check" : "mag-auto-check off"}>
              <input
                type="checkbox"
                disabled={!canMovePoly}
                checked={splitParts}
                onChange={(e) => {
                  setSplitParts(e.target.checked);
                  if (!e.target.checked) setSelPart(null);
                }}
              />
              <span>Части по отдельности</span>
            </label>
          </div>
        )}

        {/* Окошко параметров полуавтомата. Показываем только то, что влияет
            на результат при текущем инструменте. */}
        {autoOn && autoPanel && (
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
            {/* Число точек контура появляется только у контурного инструмента:
                на границы рамки оно не влияет вовсе, и в боксовой работе это
                был бы ползунок, который ничего не делает. */}
            {tool === "polygon" && (
              <label className="mag-auto-row">
                <span>Точек в контуре</span>
                <input
                  type="range" min={8} max={200} step={4}
                  value={refine.polygon_points ?? 64}
                  onChange={(e) =>
                    setRefine((r) => ({ ...r, polygon_points: Number(e.target.value) }))
                  }
                />
                <b>{refine.polygon_points ?? 64}</b>
              </label>
            )}
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
          auto={autoLive}
          autoMode={autoMode}
          autoPoints={autoPts}
          autoPreview={autoPrev}
          activeClass={active}
          selected={selected}
          selectedPart={selPart}
          splitParts={splitParts}
          canMovePoly={canMovePoly}
          grid={grid}
          reserve={filmH + 92}
          onSelect={pick}
          onBoxes={edit}
          onDrawn={() => { if (!lock) setTool("select"); }}
          onPolygon={onPolygon}
          onScale={setScale}
          onContext={(i, x, y, at) =>
            setMenu({ i, x, y, ...at, prev: selected })
          }
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
              <p className="mag-ed-objects-empty">
                {isEmpty
                  ? "Кадр объявлен фоновым — объектов на нём нет."
                  : "На кадре пока ничего не обведено."}
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
          
        </aside>
      </div>

      <FilmStrip
        grabHelp={hk("strip")}
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
          deleteLabel="объект"
          actions={menuActions(menu)}
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
