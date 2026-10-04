import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { imageFileUrl, imagePreviewUrl, saveAnnotations } from "../../auth/api";
import type { DatasetImage, LabelClass } from "../../auth/api";
import BoxCanvas from "./BoxCanvas";
import type { CanvasHandle, CanvasShape } from "./BoxCanvas";
import ClassMenu from "./ClassMenu";
import FilmStrip from "./FilmStrip";
import { AnchorButton, Badge, Button, Chip, Dot, Icon, Kbd, Meta, Pill, Select, Swatch, cx } from "../../ui";
import { count, ru } from "../ru";
import { FRAME_STATE, frameState } from "./frames/layout";
import { useAutosave } from "./useAutosave";
import { withSavedIds } from "./savedIds";

const GREY = { name: "", color: "#9aa4ae" };

function fmtBytes(bytes: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} Б`;
  const units = ["КБ", "МБ", "ГБ"];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ${units[i]}`;
}

export default function ImageViewer({
  images,
  index,
  total,
  classes,
  canEdit,
  onIndex,
  onClose,
  onNeedMore,
  onEdge,
  base = 0,
  onSaved,
}: {
  images: DatasetImage[];
  index: number;
  total: number;
  /** Сквозной номер `images[0]` во всей выборке — для счётчика. */
  base?: number;
  /** Шаг за край загруженного — листать страницу галереи. Без него, в ленте,
   *  край догружается через `onNeedMore`. */
  onEdge?: (dir: 1 | -1) => void;
  classes: LabelClass[];
  canEdit: boolean;
  onIndex: (i: number) => void;
  onClose: () => void;
  onNeedMore?: () => void;
  onSaved?: (image: DatasetImage) => void;
}) {
  const image = images[index];

  const [showBoxes, setShowBoxes] = useState(true);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  // Разметка прямо из просмотра: увидел ошибку — исправил, не заводя таску.
  const [editing, setEditing] = useState(false);
  const [boxes, setBoxes] = useState<CanvasShape[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [tool, setTool] = useState<"select" | "box">("select");
  const [menu, setMenu] = useState<{ i: number; x: number; y: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [filmH, setFilmH] = useState(164);
  // Счётчик «перечитать кадр»: отброшенная правка возвращает записанную разметку.
  const [reloadKey, setReloadKey] = useState(0);

  const canvas = useRef<CanvasHandle>(null);

  const byIndex = useMemo(() => {
    const m = new Map<number, LabelClass>();
    classes.forEach((c) => m.set(c.class_index, c));
    return m;
  }, [classes]);

  // В просмотре имя и цвет берём из самого бокса: он их несёт, а список
  // классов проекта здесь может быть ещё не загружен.
  const labelOf = useCallback(
    (ci: number) => {
      const c = byIndex.get(ci);
      if (c) return c;
      const b = image?.boxes.find((x) => x.class_index === ci);
      return b ? { name: b.name, color: b.color } : GREY;
    },
    [byIndex, image]
  );

  useEffect(() => {
    setBoxes(
      // Контур приходит вместе с рамкой; берём его целиком — просмотр обязан
      // показывать то же, что редактор, иначе объект «меняет форму» при
      // переходе между экранами.
      (image?.boxes || []).map((b) => ({
        id: b.id, class_index: b.class_index, x: b.x, y: b.y, w: b.w, h: b.h,
        ...(b.kind === "polygon" && b.parts?.length
          ? { kind: "polygon" as const, parts: b.parts }
          : {}),
      }))
    );
    setSelected(null);
    autosave.settle(image?.rev);
  }, [image?.id, reloadKey]);

  useEffect(() => {
    if (active === null && classes.length) setActive(classes[0].class_index);
  }, [classes, active]);

  // Запись — общим useAutosave, как в редакторе таски. Раньше флаг снимался
  // до ответа и после отказа не возвращался: правка пропадала молча.
  const live = useRef({ image, labelOf, onSaved, boxes });
  live.current = { image, labelOf, onSaved, boxes };
  const autosave = useAutosave<DatasetImage["boxes"][number]>(async (rev) => {
    const { image: img, labelOf: lo, onSaved: saved, boxes: snap } = live.current;
    if (!img) return rev;
    const res = await saveAnnotations(img.id, snap, rev);
    // id новых рамок — с сервера: без них каждая запись делала бы их заново.
    setBoxes((cur) => withSavedIds(snap, res.shapes, cur));
    saved?.({
      ...img,
      annotations: res.saved,
      rev: res.rev,
      boxes: withSavedIds(snap, res.shapes, snap).map((b, i) => ({
        ...b,
        id: b.id ?? `new-${i}`,
        name: lo(b.class_index).name,
        color: lo(b.class_index).color,
        source: b.source ?? "human",
      })),
    });
    return res.rev;
  });
  const { flush, touch, state: saveState, error: saveErr } = autosave;

  // Отказ или чужая правка: показать то, что записано. При «stale» свежая
  // разметка пришла в ответе сервера.
  const fresh = autosave.stale;
  const settle = autosave.settle;
  const discard = useCallback(() => {
    const img = live.current.image;
    if (img && fresh) {
      live.current.onSaved?.({ ...img, boxes: fresh.boxes, rev: fresh.rev, annotations: fresh.boxes.length });
    }
    settle(fresh?.rev ?? img?.rev);
    setReloadKey((k) => k + 1);
  }, [fresh, settle]);

  const edit = useCallback((next: CanvasShape[]) => {
    setBoxes(next);
    touch();
  }, [touch]);

  // Класс при выделенном боксе меняет его: правка чужой разметки в просмотре —
  // чаще всего именно «класс не тот».
  const pickClass = useCallback(
    (ci: number, target: number | null = selected) => {
      setActive(ci);
      if (target === null || !editing) return;
      setBoxes((prev) =>
        prev.map((b, i) => (i === target ? { ...b, class_index: ci } : b))
      );
      touch();
    },
    [selected, editing, touch]
  );

  // В режиме страниц загружена одна страница, но листает человек всю выборку:
  // шаг за её край перелистывает страницу галереи. До 01.10.2026 на последней
  // плитке стрелка просто молчала, и казалось, что кадры кончились.
  const canPrev = index > 0 || (!!onEdge && base > 0);
  const canNext =
    index < images.length - 1 || (!!onEdge && base + index < total - 1);

  const go = useCallback(
    async (delta: 1 | -1) => {
      const next = index + delta;
      if (next < 0 || next >= images.length) {
        if (!(delta < 0 ? canPrev : canNext) || !onEdge) return;
        // С незаписанной правкой с кадра не уходим: на экране видно почему.
        if (!(await flush())) return;
        onEdge(delta);
        return;
      }
      if (!(await flush())) return;
      onIndex(next);
      // У края загруженного окна просим следующую порцию заранее.
      if (onNeedMore && next >= images.length - 3) onNeedMore();
    },
    [index, images.length, onIndex, onNeedMore, onEdge, canPrev, canNext, flush]
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      // Стрелки и цифры в раскрытом (и просто сфокусированном) списке классов
      // листают сам список — перехватив их, мы листали кадры.
      if (tag === "SELECT" && e.code !== "Escape") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.code) {
        case "Escape":
          if (editing && tool === "box") setTool("select");
          else flush().then((ok) => ok && onClose());
          break;
        case "ArrowRight": go(1); break;
        case "ArrowLeft": go(-1); break;
        case "Digit0": canvas.current?.fit(); break;
        case "KeyV": if (editing) setTool("select"); break;
        case "KeyB": if (editing) setTool("box"); break;
        case "Delete":
        case "Backspace":
          if (editing && selected !== null) {
            edit(boxes.filter((_, i) => i !== selected));
            setSelected(null);
          }
          break;
        default: {
          const digit = /^Digit([1-9])$/.exec(e.code);
          if (!digit || !editing) return;
          const c = classes[Number(digit[1]) - 1];
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
  }, [go, onClose, editing, tool, selected, boxes, edit, classes, flush, pickClass]);

  // Соседние кадры подтягиваем заранее — переход стрелкой становится мгновенным.
  useEffect(() => {
    [index - 1, index + 1].forEach((i) => {
      const im = images[i];
      if (!im) return;
      const pre = new Image();
      pre.src = imagePreviewUrl(im.id);
    });
  }, [index, images]);

  // Классы, встреченные на этом кадре, — по ним же гасим боксы.
  const onFrame = useMemo(() => {
    const map = new Map<number, { name: string; color: string; count: number }>();
    boxes.forEach((b) => {
      const meta = labelOf(b.class_index);
      const cur = map.get(b.class_index);
      if (cur) cur.count += 1;
      else map.set(b.class_index, { ...meta, count: 1 });
    });
    return [...map.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [boxes, labelOf]);

  if (!image) return null;

  const w = image.width || 1;
  const h = image.height || 1;
  const st = FRAME_STATE[frameState(image.task_status, boxes.length)];
  const close = () => { void flush().then((ok) => ok && onClose()); };

  return (
    <div className="lbx" role="dialog" aria-modal="true" aria-label={image.file_name}>
      <div className="lbx-h">
        <b className="ui-mono t-ell lbx-name" title={image.file_name}>{image.file_name}</b>
        <Badge>{image.split === "other" ? "без сплита" : image.split}</Badge>
        <span className="row t-xs t-muted"><Dot color={st.color} />{st.label}</span>
        <span className="grow" />

        {editing && (saveState === "stale" || saveState === "refused" ? (
          <Pill tone="bad">
            {saveState === "stale" ? "Кадр изменил другой человек" : `Не сохранено: ${saveErr}`}
            <button type="button" className="lbx-pill-a" onClick={discard}>
              {saveState === "stale" ? "Показать его версию" : "Отбросить правку"}
            </button>
          </Pill>
        ) : saveState === "failed" ? (
          <Pill tone="warn" title={saveErr || undefined}>Не сохранено — повторяю</Pill>
        ) : (
          <span className="t-xs t-faint">{saveState === "saved" ? "Сохранено" : "Сохраняю…"}</span>
        ))}

        {editing && (
          <>
            <Button variant="ghost" size="sm" icon="pointer" aria-label="Выбор и правка — V"
              aria-pressed={tool === "select"} onClick={() => setTool("select")} />
            <Button variant="ghost" size="sm" icon="bbox" aria-label="Новая рамка — B"
              aria-pressed={tool === "box"} onClick={() => setTool("box")} />
            <Select size="sm" label="Класс" value={active === null ? undefined : String(active)}
              onChange={(v) => pickClass(Number(v))} placeholder="Класс"
              options={classes.map((c) => ({
                value: String(c.class_index),
                label: <span className="row"><Swatch color={c.color} />{c.name}</span>,
              }))} />
          </>
        )}

        <span className="ui-mono t-xs t-muted">{ru(base + index + 1)} из {ru(total)}</span>
        <Button variant="ghost" size="sm" title="Вписать в окно — 0" onClick={() => canvas.current?.fit()}>
          <span className="ui-mono">{Math.round(scale * 100)} %</span>
        </Button>
        {!editing && (
          <Button size="sm" icon={showBoxes ? "eye" : "eyeoff"} aria-pressed={showBoxes}
            onClick={() => setShowBoxes((v) => !v)}>
            Рамки
          </Button>
        )}
        {canEdit && (
          <Button size="sm" variant={editing ? "primary" : "outline"} icon={editing ? "tick" : "bbox"}
            title="Правка разметки прямо здесь"
            onClick={() => {
              if (editing) void flush();
              setEditing((v) => !v);
              setTool("select");
              setShowBoxes(true);
            }}>
            {editing ? "Готово" : "Разметить"}
          </Button>
        )}
        <AnchorButton variant="ghost" size="sm" icon="download" href={imageFileUrl(image.id)}
          download={image.file_name} title="Скачать оригинал" aria-label="Скачать оригинал" />
        <Button variant="ghost" size="sm" icon="x" aria-label="Закрыть (Esc)" onClick={close} />
      </div>

      <div className="lbx-b">
        <button className="lbx-nav" type="button" onClick={() => go(-1)} disabled={!canPrev}
          aria-label="Предыдущий кадр">
          <Icon name="chevL" />
        </button>

        <div className="lbx-stage">
          <BoxCanvas
            ref={canvas}
            imageId={image.id}
            fileName={image.file_name}
            width={w}
            height={h}
            boxes={showBoxes ? boxes : []}
            labelOf={labelOf}
            hidden={hidden}
            editable={editing}
            tool={tool}
            activeClass={active}
            selected={selected}
            grid={false}
            reserve={filmH + 100}
            onSelect={setSelected}
            onBoxes={edit}
            onDrawn={() => setTool("select")}
            onScale={setScale}
            onContext={(i, x, y) => setMenu({ i, x, y })}
          />
        </div>

        <button className="lbx-nav" type="button" onClick={() => go(1)} disabled={!canNext}
          aria-label="Следующий кадр">
          <Icon name="chevR" />
        </button>

        <aside className="lbx-s">
          <div className="lbx-st">Объекты <span className="ui-mono">{boxes.length}</span></div>
          {onFrame.length === 0 ? (
            <p className="t-sm t-muted">
              {editing ? "Выберите класс, нажмите B и протяните рамку." : "Разметки нет."}
            </p>
          ) : onFrame.map(([idx, c]) => (
            // Щелчок по классу гасит его рамки — подсказка в title
            <button key={idx} type="button" className={cx("lbx-obj", hidden.has(idx) && "off")}
              title={hidden.has(idx) ? "Показать класс" : "Скрыть класс"}
              onClick={() => setHidden((prev) => {
                const next = new Set(prev);
                if (next.has(idx)) next.delete(idx);
                else next.add(idx);
                return next;
              })}>
              <Swatch color={c.color} />
              <span className="t-ell grow">{c.name}</span>
              <span className="ui-mono t-xs t-faint">{c.count}</span>
              <Icon name={hidden.has(idx) ? "eyeoff" : "eye"} size={14} />
            </button>
          ))}
          <hr className="ov-sep" />
          <Meta items={[
            ["Размер", <span className="ui-mono">{w} × {h}</span>],
            ["Вес", fmtBytes(image.size_bytes)],
            ...(image.dataset_name ? [["Датасет", image.dataset_name] as [ReactNode, ReactNode]] : []),
            ...(image.tags?.length
              ? [["Таги", <span className="row wrap">{image.tags.map((t) => <Chip key={t}>{t}</Chip>)}</span>] as [ReactNode, ReactNode]]
              : []),
          ]} />
          <hr className="ov-sep" />
          <p className="lbx-keys">
            {editing && <><Kbd>V</Kbd> выбор <Kbd>B</Kbd> рамка <Kbd>1–9</Kbd> класс <Kbd>Del</Kbd> удалить<br /></>}
            <Kbd>←</Kbd> <Kbd>→</Kbd> кадры · колесо — зум · <Kbd>0</Kbd> вписать
          </p>
        </aside>
      </div>

      <FilmStrip
        items={images.map((im) => ({
          id: im.id,
          width: im.width,
          height: im.height,
          boxes: im.boxes,
          title: `${im.file_name} — ${count(im.annotations, "объект", "объекта", "объектов")}`,
        }))}
        index={index}
        onPick={(i) => { void flush().then((ok) => ok && onIndex(i)); }}
        storageKey="mag-film-h-view"
        onHeight={setFilmH}
      />

      {menu && (
        <ClassMenu
          classes={classes}
          at={{ x: menu.x, y: menu.y }}
          current={boxes[menu.i]?.class_index ?? null}
          onPick={(ci) => { pickClass(ci, menu.i); setMenu(null); }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
