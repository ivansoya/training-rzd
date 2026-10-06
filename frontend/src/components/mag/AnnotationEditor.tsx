import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ensureClass,
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
import { frameActions } from "./frameActions";
import * as history from "./editHistory";
import { empty, type History } from "./editHistory";
import TagPicker from "./TagPicker";
import { hasLayer } from "./useEscape";
import { useAutosave } from "./useAutosave";
import { withSavedIds } from "./savedIds";
import type { Tag } from "../../api/tags";
import { useAutoLabel } from "./useAutoLabel";
import AutoStatus from "./AutoStatus";
import { useLive } from "../../live/LiveProvider";
import type { AutoRefine } from "../../auth/api";
import type { TaskBox } from "../../auth/api";
import { Button, Notice, StackBar, Switch } from "../../ui";
import { ru } from "../ru";
import AutoSettings from "../editor/AutoSettings";
import ClassPicker from "../editor/ClassPicker";
import { EditorHead, Float, KeysDialog, SaveNote, ToolButton, ToolMenu, ZoomChip } from "../editor/Chrome";
import { AutoBar, FrameBar, FrameSide } from "../editor/FramePanels";
import { STATUS_LOOK, digitClass, isTyping, ownsArrows, progressOf, stagePad } from "../editor/look";
import type { KeyGroup } from "../editor/look";

/** Окно «Клавиши»: всё управление редактора кадров. */
const KEYS: KeyGroup[] = [
  { title: "Инструменты", keys: [
    ["V", "Выбор и правка"],
    ["B", "Рамка. Ещё раз B — залипание, рисовать подряд"],
    ["P", "Контур. Замкнуть — щелчок по первой точке или Enter"],
    ["Shift+P", "Следующий контур ляжет в выбранный объект"],
    ["A", "Полуавтомат SAM2 поверх рамки или контура"],
    ["1–9", "Класс: при выбранном объекте — перекрасить его"],
    ["Alt", "Новая точка контура под курсором"],
  ] },
  { title: "Правка", keys: [
    ["Del", "Удалить объект, а при раздельных частях — часть"],
    ["Ctrl+Z", "Отменить правку"],
    ["Ctrl+Shift+Z / Ctrl+Y", "Повторить"],
    ["Esc", "Снять начатое по шагу, на дне — выйти из разметки"],
  ] },
  { title: "Кадр", keys: [
    ["E", "Пусто: объектов на кадре нет (ещё раз — снять)"],
    ["S", "Отложить кадр (ещё раз — снять)"],
    ["X", "Брак; у забракованного — вернуть"],
    ["Пробел", "Далее; при показанном полуавтоматом — закрепить"],
    ["← / →", "Предыдущий и следующий кадр"],
  ] },
  { title: "Вид", keys: [
    ["Колесо", "Зум"],
    ["Shift+протяжка", "Двигать полотно"],
    ["0", "Вписать кадр"],
    ["Tab", "Спрятать или показать панели"],
    ["?", "Это окно"],
  ] },
  { title: "Полуавтомат", keys: [
    ["Щелчок", "Объект под курсором; щелчок мимо — закрепить"],
    ["Shift+щелчок", "Уточнить показанное или доуточнить рамку"],
    ["Shift+правая", "Убрать участок из показанного"],
  ] },
];

const GREY = { name: "", color: "#9aa4ae" };
const SIDE_W = 280;

// Последняя запись разметки, в том числе ушедшая при закрытии редактора.
// Страница таски ждёт её перед тем, как перечитать кадры: иначе чтение,
// отправленное сразу за закрытием, обгоняет запись и показывает старое.
let lastSave: Promise<unknown> = Promise.resolve();
export function saveSettled(): Promise<void> {
  return lastSave.then(() => undefined, () => undefined);
}

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
  tags,
  onIndex,
  onClose,
  onChanged,
  onTags,
  onTagCreated,
  canTag,
}: {
  code: string;
  taskName: string;
  images: TaskImage[];
  index: number;
  readOnly: boolean;
  /** Можно ли править таги. Не то же, что `readOnly`: закрытая таска
   *  останавливает разметку, но не таги — сервер их принимает (см.
   *  set_image_tags), а таг — паспорт кадра, и ошибку в нём иначе нечем
   *  исправить. */
  canTag: boolean;
  /** Справочник тагов проекта. */
  tags: Tag[];
  onIndex: (i: number) => void;
  onClose: () => void;
  /** Что поменялось у кадра. Заплатка, а не кадр целиком: целый кадр из
   *  замыкания затирал бы свежую разметку, записанную мгновением раньше
   *  («нарисовал — Отложить» возвращал в ленту разметку до рисования). */
  onChanged: (imageId: string, patch: Partial<TaskImage>) => void;
  /** Таги этого кадра. Единственное место, где их правят после того, как
   *  кадр ушёл в датасет, — и правят по одному кадру. */
  onTags: (imageId: string, tagIds: string[]) => void;
  onTagCreated: (tag: Tag) => void;
}) {
  const image = images[index];

  const [classes, setClasses] = useState<LabelClass[]>([]);
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
  // Ctrl+Z это вернёт, но только если сдвиг заметили сразу.
  const [canMovePoly, setCanMovePoly] = useState(false);
  const [splitParts, setSplitParts] = useState(false);
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
  const [filmW, setFilmW] = useState(120);
  // Счётчик «перечитать кадр»: отброшенная правка возвращает разметку с сервера.
  const [reloadKey, setReloadKey] = useState(0);
  const [grid, setGrid] = useState(true);
  const [keysOpen, setKeysOpen] = useState(false);
  // Tab прячет плавающие панели — кадр виден целиком
  const [panels, setPanels] = useState(true);
  // Объекты, скрытые глазом в списке: только вид, в разметке они остаются
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const canvas = useRef<CanvasHandle>(null);
  // Разметка «как сейчас» — синхронно, мимо отрисовки: запись, отмена и уход
  // со страницы должны видеть последнюю правку, даже если React её ещё не
  // отрисовал (протяжка шлёт правки чаще, чем кадры экрана).
  const boxesRef = useRef<CanvasShape[]>(boxes);
  const hist = useRef<History<CanvasShape[]>>(empty());
  // Жест мыши: «down» — нажали, «recorded» — снимок до жеста уже в истории.
  // Протяжка шлёт правку на каждое движение, а шаг отмены у неё один.
  const gesture = useRef<"none" | "down" | "recorded">("none");

  const iw = image?.width || 1;
  const ih = image?.height || 1;
  // Забракованный кадр смотрим, но не правим: иначе он оживёт незаметно.
  const frozen = readOnly || image?.task_status === "deleted";

  const loadClasses = useCallback(() => {
    getClasses(code).then((c) => {
      setClasses(c.classes);
      setActive((prev) => prev ?? (c.classes[0]?.class_index ?? null));
    }).catch(() => {});
  }, [code]);

  useEffect(loadClasses, [loadClasses]);

  // Класс могли удалить или переименовать, пока кадр открыт. Список слева
  // обновится сразу; боксы в памяти помечены номером класса и останутся
  // старыми до перечитывания кадра — их поймает отказ при сохранении.
  useLive("classes", loadClasses);

  // Кадр сменился — берём его разметку как есть. История у каждого кадра
  // своя: отмена на новом кадре не должна возвращать разметку прежнего.
  useEffect(() => {
    const next = (image?.boxes || []).map((b) => ({
      id: b.id, class_index: b.class_index, x: b.x, y: b.y, w: b.w, h: b.h,
      ...(b.kind === "polygon" && b.parts?.length
        ? { kind: "polygon" as const, parts: b.parts }
        : {}),
    }));
    boxesRef.current = next;
    setBoxes(next);
    hist.current = empty();
    setAddTo(null);
    setSelected(null);
    setSelPart(null);
    setHidden(new Set());
    autosave.settle(image?.rev);
    // Ошибка прошлого кадра к этому не относится.
    setError(null);
  }, [image?.id, reloadKey]);

  const byIndex = useMemo(() => {
    const m = new Map<number, LabelClass>();
    classes.forEach((c) => m.set(c.class_index, c));
    return m;
  }, [classes]);

  const labelOf = useCallback(
    (ci: number) => byIndex.get(ci) || GREY,
    [byIndex]
  );

  // Подпись рамки — по её номеру: кто поставил и каким агентом.
  const meta = useMemo(
    () => new Map((image?.boxes || []).map((b) => [b.id, b])),
    [image?.boxes]
  );
  const agentFrame =
    image?.task_status === "new" &&
    (image?.boxes || []).some((b) => b.source === "model" && b.agent);
  const actions = image
    ? frameActions({ status: image.task_status, objects: boxes.length, agentFrame, readOnly })
    : [];
  const canEmpty = actions.includes("empty");

  const progress = useMemo(() => progressOf(images), [images]);

  // Всё, что нужно записи, — через ref: запись стоит в очереди и может
  // выполниться после следующей отрисовки, а брать ей надо свежее.
  const live = useRef({ image, labelOf, meta, onChanged });
  live.current = { image, labelOf, meta, onChanged };

  /** Автосохранение: разметчик не должен помнить про кнопку «сохранить».
   *
   *  Отвечает, записано ли. Сбой не выбрасывает правку: она снова «грязная»,
   *  на экране «не сохранено», запись повторяется сама, а переход на другой
   *  кадр и закрытие ждут успеха. Состояния и очередь — в общем useAutosave. */
  const autosave = useAutosave<TaskBox>(async (rev) => {
    const { image: img } = live.current;
    if (!img) return rev;
    const snap = boxesRef.current;
    const res = await saveAnnotations(img.id, snap, rev);
    // id новых рамок — с сервера, к тем же объектам: иначе каждая запись делала бы их заново.
    const now = withSavedIds(snap, res.shapes, boxesRef.current);
    if (now !== boxesRef.current) {
      boxesRef.current = now;
      setBoxes(now);
    }
    const sent = withSavedIds(snap, res.shapes, snap);
    const { labelOf: lo, meta: mt, onChanged: changed } = live.current;
    changed(img.id, {
      annotations: res.saved,
      task_status: res.task_status as ImageTaskStatus,
      rev: res.rev,
      // Номер рамки — настоящий, если он был: по нему сервер узнаёт
      // нетронутую рамку агента при следующем сохранении этого кадра.
      boxes: sent.map((b, i) => ({
        ...(mt.get(b.id ?? "") ?? { source: "human" }),
        ...b,
        id: b.id ?? `new-${i}`,
        name: lo(b.class_index).name,
        color: lo(b.class_index).color,
      })),
    });
    return res.rev;
  });
  const { dirty, chain, touch, state: saveState, error: saveErr } = autosave;
  const autoFlush = autosave.flush;
  const flush = useCallback((): Promise<boolean> => {
    const p = autoFlush();
    lastSave = p;
    return p;
  }, [autoFlush]);

  // Ушли, не дождавшись паузы: «Назад», перезагрузка, закрытие вкладки. При
  // уходе внутри приложения редактор размонтируется, при перезагрузке —
  // нет, там ловим pagehide. Запрос с keepalive переживает выгрузку страницы
  // (так же уходит последняя правка графа аугментаций); его тело ограничено
  // 64 КБ, и больший контур уходит обычным запросом — внутри приложения он
  // дойдёт, а при закрытии вкладки это потолок, выше которого не прыгнуть.
  useEffect(() => {
    const leave = (unloading: boolean) => {
      const img = live.current.image;
      if (!dirty.current || !img) return;
      dirty.current = false;
      const send = (keepalive: boolean) =>
        fetch(`/api/images/${img.id}/annotations`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ boxes: boxesRef.current, rev: autosave.rev.current }),
          keepalive,
        });
      const go = () => send(true).catch(() => send(false)).catch(() => undefined);
      // Выгрузка ждать очереди не может: к тому времени страницы уже не будет.
      lastSave = unloading ? go() : chain.current.then(go, go);
    };
    const onHide = () => leave(true);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      leave(false);
    };
  }, []);

  /** Правка разметки. Снимок «до» уходит в историю — один на жест мыши и по
   *  одному на каждую правку с клавиатуры или из меню. */
  const edit = useCallback((next: CanvasShape[]) => {
    if (gesture.current !== "recorded") {
      hist.current = history.record(hist.current, boxesRef.current);
      if (gesture.current === "down") gesture.current = "recorded";
    }
    // Номера скрытых держатся за место в списке — при смене числа объектов они съехали бы
    if (next.length !== boxesRef.current.length) setHidden((h) => (h.size ? new Set() : h));
    boxesRef.current = next;
    setBoxes(next);
    touch();
  }, [touch]);

  // Жест мыши кончился. Пустой жест (клик рамкой без протяжки: рамку
  // добавили и сразу убрали как промах) шага отмены не оставляет.
  useEffect(() => {
    const up = () => {
      if (gesture.current === "recorded") {
        hist.current = history.dropNoop(
          hist.current, boxesRef.current,
          (a, b) => JSON.stringify(a) === JSON.stringify(b)
        );
      }
      gesture.current = "none";
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  /** Отмена и повтор. Результат — обычная правка: уходит автосохранением. */
  const step = useCallback((dir: "undo" | "redo") => {
    if (frozen) return;
    const got = (dir === "undo" ? history.undo : history.redo)(hist.current, boxesRef.current);
    if (!got) return;
    hist.current = got.h;
    boxesRef.current = got.value;
    setBoxes(got.value);
    touch();
    // Номер выбранного мог указывать на объект, которого в снимке нет.
    setSelected(null);
    setSelPart(null);
  }, [frozen, touch]);

  // Выбор класса при выделенном боксе перекрашивает его: чаще всего класс
  // выбирают именно затем, чтобы исправить уже нарисованное.
  // В инструментах рисования класс задаёт следующий объект: иначе закреплённый
  // только что (он остаётся выделенным) молча перекрашивался бы.
  const pickClass = useCallback(
    (ci: number, target: number | null = tool === "select" ? selected : null) => {
      setActive(ci);
      if (target === null || frozen) return;
      edit(boxesRef.current.map((b, i) => (i === target ? { ...b, class_index: ci } : b)));
    },
    [selected, frozen, edit, tool]
  );

  /** Уйти с кадра можно только записав его: при сбое остаёмся, и на экране
   *  «не сохранено» — переход не случается молча. */
  const jump = useCallback(
    async (target: number) => {
      if (!(await flush())) return;
      if (target >= 0 && target < images.length) onIndex(target);
    },
    [flush, images.length, onIndex]
  );

  const close = useCallback(async () => {
    if (await flush()) onClose();
  }, [flush, onClose]);

  // Отказ сервера или чужая правка: свою не спасти — показать то, что записано.
  // При «stale» свежая разметка пришла в ответе, второго запроса не нужно.
  const fresh = autosave.stale;
  const settle = autosave.settle;
  const discard = useCallback(() => {
    const img = live.current.image;
    if (img && fresh) {
      live.current.onChanged(img.id, {
        boxes: fresh.boxes,
        rev: fresh.rev,
        annotations: fresh.boxes.length,
        ...(fresh.task_status ? { task_status: fresh.task_status as ImageTaskStatus } : {}),
      });
    }
    settle(fresh?.rev ?? img?.rev);
    setReloadKey((k) => k + 1);
  }, [fresh, settle]);

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
      if (!(await flush())) return;
      try {
        const res = await setImageTaskStatus(image.id, status);
        onChanged(image.id, { task_status: res.task_status });
        setError(null);
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
    // Прежнее состояние и датасет восстановит сервер; присланное — запасное.
    if (image.task_status === "deleted") {
      return verdict(image.annotations > 0 ? "annotated" : "new", false);
    }
    if (!(await flush())) return;
    try {
      await deleteImage(image.id);
      onChanged(image.id, { task_status: "deleted" });
      setError(null);
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
    images[index + 1] ? { image_id: images[index + 1].id } : null,
    undefined,
    null,
    code
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
  const setAutoError = auto.setError;
  useEffect(() => { clearAuto(); setAutoError(null); }, [image?.id, clearAuto, setAutoError]);

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
            source: "model",
          }
        : {
            class_index: active,
            x: autoPrev.x, y: autoPrev.y, w: autoPrev.w, h: autoPrev.h,
            source: "model",
          };
    if (replacing !== null && boxes[replacing]) {
      // Доуточнение меняет только форму: класс, id и авторство агента — прежние.
      const base = boxes[replacing];
      const refined: CanvasShape = {
        ...base,
        kind: shape.kind, parts: shape.parts,
        x: shape.x, y: shape.y, w: shape.w, h: shape.h,
      };
      edit(boxes.map((b, i) => (i === replacing ? refined : b)));
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
      if (hasLayer()) return;
      // Флажок и ползунок — не печать: после щелчка по ним V/B/P работают
      if (isTyping(e.target) || ownsArrows(e.target, e.key)) return;
      if (e.key === "?") { setKeysOpen(true); e.preventDefault(); return; }
      if (e.code === "Tab" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setPanels((v) => !v);
        e.preventDefault();
        return;
      }
      // Отмена и повтор. По коду клавиши, а не по букве: в русской раскладке
      // e.key у Z — «я».
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === "KeyZ" || e.code === "KeyY")) {
        step(e.code === "KeyY" || e.shiftKey ? "redo" : "undo");
        e.preventDefault();
        return;
      }
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
          else if (selected !== null) pick(null);
          else void close();
          break;
        case "Space":
          // Пробел закрепляет показанное, и только без него листает дальше.
          if (autoPrev) commitAuto();
          else go(1);
          break;
        // Enter нативно нажал бы кнопку в фокусе — «Удалить» забраковала бы следующий кадр.
        case "Enter":
        case "NumpadEnter":
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
        // Фоновым кадр с объектом не бывает — клавиша молчит, как и плашка.
        case "KeyE": if (canEmpty) toggle("empty"); break;
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
          const c = digitClass(classes, e.code);
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
  }, [go, close, step, selected, selPart, splitParts, classes, tool, autoOn,
      addTo, frozen, pickTool, addContour, toggle, trash, boxes, edit, pick,
      pickClass, auto.state, pickAuto, autoPrev, autoPts, clearAuto, commitAuto, canEmpty]);

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

  const pad = stagePad({ panels, film: filmW, side: SIDE_W });
  const canPrev = images.slice(0, index).some((im) => im.task_status !== "deleted");
  const canNext = images.slice(index + 1).some((im) => im.task_status !== "deleted");
  const autoTitle = auto.state === "ready" ? undefined
    : auto.state === "error" ? `Модель недоступна: ${auto.error || "неизвестная ошибка"}` : "Модель готовится…";

  return (
    <div className="ed fe" role="dialog" aria-modal="true" aria-label="Разметка кадров">
      <EditorHead
        onBack={() => void close()}
        backLabel="К таске (Esc)"
        title={taskName}
        sub={<>Кадр <span className="ui-mono">{ru(index + 1)}</span> из <span className="ui-mono">{ru(images.length)}</span> · {image.file_name}</>}
        extra={
          <div className="ed-prog" title={STATUS_LOOK.map((s) => `${s.label}: ${progress.counts[s.id]}`).join(" · ")}>
            <StackBar label="Прогресс" parts={STATUS_LOOK.map((s) => ({ label: s.label, value: progress.counts[s.id], color: s.color }))} />
            <div className="row t-xs t-muted">
              <span>решено <span className="ui-mono">{ru(progress.decided)}</span></span>
              <span className="grow" />
              <span className="ui-mono">{Math.round(progress.pct * 100)} %</span>
            </div>
          </div>
        }
      >
        <SaveNote state={saveState} error={saveErr} onDiscard={discard} />
        <i className="ed-vsep" />
        <Button variant="ghost" size="sm" icon="keyboard" kbd="?" onClick={() => setKeysOpen(true)}>Клавиши</Button>
        <Button variant="ghost" size="sm" icon="sliders" kbd="Tab" aria-pressed={!panels}
          title={panels ? "Спрятать панели" : "Показать панели"} onClick={() => setPanels((v) => !v)}>Панели</Button>
      </EditorHead>

      {error && (
        <div className="ed-notes"><Notice tone="error" onClose={() => setError(null)}>{error}</Notice></div>
      )}

      <div
        className={autoLive && auto.busy ? "ed-main auto-wait" : "ed-main"}
        style={{ ["--pt" as string]: `${pad.top}px`, ["--pr" as string]: `${pad.right}px`,
          ["--pb" as string]: `${pad.bottom}px`, ["--pl" as string]: `${pad.left}px` }}
        onPointerDownCapture={() => { gesture.current = "down"; }}
      >
        <BoxCanvas
          ref={canvas}
          imageId={image.id}
          fileName={image.file_name}
          width={iw}
          height={ih}
          boxes={boxes}
          hiddenItems={hidden}
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
          reserve={56}
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

        {panels && (
          <Float className="ed-top" role="toolbar" label="Инструменты">
            <ToolButton icon="pointer" label="Выбор" k="V" pressed={tool === "select"}
              onClick={() => { setTool("select"); setLock(false); setAddTo(null); }} />
            <ToolButton icon="bbox" label="Рамка" k="B" pressed={tool === "box"} disabled={frozen}
              locked={tool === "box" && lock} onClick={() => pickTool("box")} />
            <ToolButton icon="poly" label="Контур" k="P" pressed={tool === "polygon"} disabled={frozen}
              onClick={() => { setTool("polygon"); setAddTo(null); }} />
            <ToolMenu label="Настройки контура" width={260}>
              <div className="ed-set-b">
                <div className="ui-pop-h">Контур</div>
                <label className="ed-set-row">
                  <span>Двигать контуры</span>
                  <Switch label="Двигать контуры" checked={canMovePoly}
                    onChange={(v) => { setCanMovePoly(v); if (!v) setSplitParts(false); }} />
                </label>
                <label className="ed-set-row">
                  <span>Части по отдельности</span>
                  <Switch label="Части по отдельности" checked={splitParts} disabled={!canMovePoly}
                    onChange={(v) => { setSplitParts(v); if (!v) setSelPart(null); }} />
                </label>
                <p className="ed-set-hint">Контур правят по вершинам; перенос целиком включается здесь.</p>
              </div>
            </ToolMenu>
            <i className="ed-vsep" />
            <ToolButton icon="sparkle" label="Полуавтомат SAM2" k="A" pressed={autoOn}
              disabled={frozen || auto.state !== "ready"} warming={auto.state === "starting"}
              title={autoTitle} onClick={pickAuto} />
            <ToolMenu label="Настройки полуавтомата" width={300}>
              <AutoSettings refine={refine} onRefine={setRefine} mode={autoMode}
                onMode={(m) => { setAutoMode(m); clearAuto(); }} polygon={tool === "polygon"}
                afterSelect={afterCommit === "select"} onAfterSelect={(v) => setAfterCommit(v ? "select" : "new")}
                error={auto.error} />
            </ToolMenu>
            <i className="ed-vsep" />
            <ClassPicker classes={classes} active={active}
              onPick={(ci) => pickClass(ci)}
              onCreate={frozen ? undefined : async (name) => {
                try {
                  const c = await ensureClass(code, name);
                  setClasses((prev) => (prev.some((p) => p.id === c.id) ? prev : [...prev, c]));
                  pickClass(c.class_index);
                } catch (e) {
                  setError((e as Error).message);
                }
              }} />
          </Float>
        )}

        <div className="ed-plates">
          <AutoStatus state={auto.state} error={auto.error} busy={auto.busy} on={autoOn}
            quiet={frozen} onRetry={auto.retry} onDismiss={() => auto.setError(null)} />
          {addTo !== null && (
            <div className="mag-auto-plate" role="status">Следующий контур ляжет в выбранный объект · Esc — отменить</div>
          )}
        </div>

        {panels && (
          <Float className="fe-film" label="Кадры таски">
            <FilmStrip
              vertical
              items={images.map((im) => ({
                id: im.id,
                width: im.width,
                height: im.height,
                boxes: im.boxes,
                ring: im.task_status,
                title: `${im.file_name} — ${im.annotations} разметок`,
              }))}
              index={index}
              onPick={jump}
              onSize={setFilmW}
            />
          </Float>
        )}

        {panels && (
          <Float className="fe-side" label="Кадр и объекты">
            <FrameSide
              status={image.task_status}
              tags={
                <TagPicker code={code} all={tags} value={image.tag_ids || []} disabled={!canTag} compact
                  placeholder="таг кадра" onChange={(next) => onTags(image.id, next)} onCreated={onTagCreated} />
              }
              boxes={boxes}
              labelOf={labelOf}
              meta={meta}
              classes={classes}
              selected={selected}
              hidden={hidden}
              frozen={frozen}
              onSelect={(i) => pick(i)}
              onHide={(i) => setHidden((h) => {
                const next = new Set(h);
                if (next.has(i)) next.delete(i); else next.add(i);
                return next;
              })}
              onClass={(i, ci) => pickClass(ci, i)}
              onDelete={(i) => { edit(boxes.filter((_, k) => k !== i)); pick(null); }}
              onAddContour={(i) => { pick(i); setAddTo(i); setTool("polygon"); }}
            />
          </Float>
        )}

        {panels && (
          <Float className="ed-bot" role="toolbar" label={autoPrev ? "Показанное моделью" : "Решение по кадру"}>
            {autoPrev ? (
              <AutoBar onCommit={commitAuto} onCancel={clearAuto} />
            ) : (
              <FrameBar index={index} total={images.length} canPrev={canPrev} canNext={canNext}
                actions={actions} status={image.task_status}
                onPrev={() => void go(-1)} onNext={() => void go(1)}
                onAccept={() => void verdict("annotated", true)}
                onToggle={(s) => void toggle(s)} onTrash={() => void trash()} onGo={() => void go(1)} />
            )}
          </Float>
        )}

        <ZoomChip scale={scale} onZoom={(k) => canvas.current?.zoomBy(k)} onFit={() => canvas.current?.fit()}
          grid={grid} onGrid={() => setGrid((g) => !g)} />
      </div>

      <KeysDialog open={keysOpen} onOpenChange={setKeysOpen} groups={KEYS} />

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
