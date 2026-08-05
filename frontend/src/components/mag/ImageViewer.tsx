import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { imageFileUrl, imagePreviewUrl, saveAnnotations } from "../../auth/api";
import type { DatasetImage, LabelClass } from "../../auth/api";
import BoxCanvas from "./BoxCanvas";
import type { CanvasBox, CanvasHandle } from "./BoxCanvas";
import ClassMenu from "./ClassMenu";
import FilmStrip from "./FilmStrip";

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
  onSaved,
}: {
  images: DatasetImage[];
  index: number;
  total: number;
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
  const [boxes, setBoxes] = useState<CanvasBox[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [tool, setTool] = useState<"select" | "box">("select");
  const [menu, setMenu] = useState<{ i: number; x: number; y: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [filmH, setFilmH] = useState(164);
  const [saved, setSaved] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const canvas = useRef<CanvasHandle>(null);
  const dirty = useRef(false);

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
      (image?.boxes || []).map((b) => ({
        class_index: b.class_index, x: b.x, y: b.y, w: b.w, h: b.h,
      }))
    );
    setSelected(null);
    dirty.current = false;
    setSaved(true);
  }, [image?.id]);

  useEffect(() => {
    if (active === null && classes.length) setActive(classes[0].class_index);
  }, [classes, active]);

  const flush = useCallback(async () => {
    if (!dirty.current || !image) return;
    dirty.current = false;
    try {
      const res = await saveAnnotations(image.id, boxes);
      setSaved(true);
      onSaved?.({
        ...image,
        annotations: res.saved,
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
  }, [boxes, image, labelOf, onSaved]);

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

  // Класс при выделенном боксе меняет его: правка чужой разметки в просмотре —
  // чаще всего именно «класс не тот».
  const pickClass = useCallback(
    (ci: number, target: number | null = selected) => {
      setActive(ci);
      if (target === null || !editing) return;
      setBoxes((prev) =>
        prev.map((b, i) => (i === target ? { ...b, class_index: ci } : b))
      );
      dirty.current = true;
    },
    [selected, editing]
  );

  const go = useCallback(
    async (delta: number) => {
      const next = index + delta;
      if (next < 0 || next >= images.length) return;
      await flush();
      onIndex(next);
      // У края загруженного окна просим следующую порцию заранее.
      if (onNeedMore && next >= images.length - 3) onNeedMore();
    },
    [index, images.length, onIndex, onNeedMore, flush]
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.code) {
        case "Escape":
          if (editing && tool === "box") setTool("select");
          else flush().then(onClose);
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

  return (
    <div className="mag-viewer" role="dialog" aria-modal="true" aria-label={image.file_name}>
      <div className="mag-v-head">
        <b>{image.file_name}</b>
        <span className="mag-v-cnt">
          {index + 1} из {total.toLocaleString("ru-RU")}
        </span>
        <span className="mag-v-sp" />
        {error && <span className="mag-ed-err">{error}</span>}
        {editing && (
          <span className={saved ? "mag-ed-saved" : "mag-ed-saving"}>
            {saved ? "сохранено" : "сохраняю…"}
          </span>
        )}

        {editing ? (
          <span className="mag-v-tools">
            <button className={tool === "select" ? "mag-tool on" : "mag-tool"}
              type="button" title="Выбор и правка — V" onClick={() => setTool("select")}>
              ↖
            </button>
            <button className={tool === "box" ? "mag-tool on" : "mag-tool"}
              type="button" title="Новая рамка — B" onClick={() => setTool("box")}>
              ▢
            </button>
            <select
              className="mag-v-cls"
              value={active ?? ""}
              aria-label="Класс"
              onChange={(e) => pickClass(Number(e.target.value))}
            >
              {classes.map((c) => (
                <option key={c.id} value={c.class_index}>
                  {c.class_index} · {c.name}
                </option>
              ))}
            </select>
          </span>
        ) : (
          <button className="mag-v-btn" type="button" onClick={() => setShowBoxes((v) => !v)}>
            Разметка: {showBoxes ? "вкл" : "выкл"}
          </button>
        )}

        <button className="mag-tool wide" type="button" title="Вписать в окно — 0"
          onClick={() => canvas.current?.fit()}>
          {Math.round(scale * 100)}%
        </button>

        {canEdit && (
          <button
            className={editing ? "mag-v-btn on" : "mag-v-btn"}
            type="button"
            onClick={() => {
              if (editing) flush();
              setEditing((v) => !v);
              setTool("select");
              setShowBoxes(true);
            }}
            title="Правка разметки прямо здесь"
          >
            {editing ? "Готово" : "Разметить"}
          </button>
        )}
        <a className="mag-v-btn" href={imageFileUrl(image.id)} download={image.file_name}>
          Скачать
        </a>
        <button className="mag-v-btn" type="button"
          onClick={() => flush().then(onClose)} aria-label="Закрыть">
          ✕
        </button>
      </div>

      <div className="mag-v-body">
        <div className="mag-v-stage">
          <button className="mag-v-arrow l" type="button" onClick={() => go(-1)}
            disabled={index === 0} aria-label="Предыдущий кадр">
            ‹
          </button>

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
            reserve={filmH + 92}
            onSelect={setSelected}
            onBoxes={edit}
            onDrawn={() => setTool("select")}
            onScale={setScale}
            onContext={(i, x, y) => setMenu({ i, x, y })}
          />

          <button className="mag-v-arrow r" type="button" onClick={() => go(1)}
            disabled={index >= images.length - 1} aria-label="Следующий кадр">
            ›
          </button>
        </div>

        <aside className="mag-v-side">
          <h5>Кадр</h5>
          <div className="mag-v-kv"><span>Сплит</span><b>{image.split}</b></div>
          <div className="mag-v-kv"><span>Разрешение</span><b>{w}×{h}</b></div>
          <div className="mag-v-kv"><span>Вес</span><b>{fmtBytes(image.size_bytes)}</b></div>
          <div className="mag-v-kv"><span>Объектов</span><b>{boxes.length}</b></div>

          <h5>Объекты</h5>
          {onFrame.length === 0 ? (
            <p className="mag-v-empty">
              {editing
                ? "Выберите класс, нажмите B и протяните рамку."
                : "Разметки нет — это негативный пример, а не потеря."}
            </p>
          ) : (
            <>
              {onFrame.map(([idx, c]) => (
                <button
                  key={idx}
                  type="button"
                  className={hidden.has(idx) ? "mag-v-obj off" : "mag-v-obj"}
                  title={hidden.has(idx) ? "Показать класс" : "Скрыть класс"}
                  onClick={() =>
                    setHidden((prev) => {
                      const next = new Set(prev);
                      next.has(idx) ? next.delete(idx) : next.add(idx);
                      return next;
                    })
                  }
                >
                  <i style={{ background: c.color }} />
                  <span className="mag-v-obj-name">{c.name}</span>
                  <span className="mag-v-obj-id">id {idx}</span>
                  <span className="mag-v-obj-n">{c.count}</span>
                </button>
              ))}
              <p className="mag-v-hint">Нажмите на класс, чтобы скрыть его боксы.</p>
            </>
          )}

          <p className="mag-ed-keys">
            {editing ? (
              <>
                <kbd>V</kbd> выбор <kbd>B</kbd> рамка <kbd>1–9</kbd> класс{" "}
                <kbd>Del</kbd> удалить<br />
              </>
            ) : null}
            <kbd>←</kbd> <kbd>→</kbd> кадры · протяжка — полотно · колесо — зум ·{" "}
            <kbd>0</kbd> вписать
          </p>
        </aside>
      </div>

      <FilmStrip
        items={images.map((im) => ({
          id: im.id,
          width: im.width,
          height: im.height,
          boxes: im.boxes,
          title: `${im.file_name} · ${im.annotations} объектов`,
        }))}
        index={index}
        onPick={(i) => { flush(); onIndex(i); }}
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
