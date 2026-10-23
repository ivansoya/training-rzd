// «Свои картинки» в окне «Образцы класса» (решения 23.10.2026, макет d1–d7).
//
// Полка — имя класса; картинки грузятся по одной, у каждой своя полоса хода и свой отказ. Рамка на карточке —
// плитка набора: щелчок кладёт её в набор или убирает. Щелчок мимо рамок или ✎ — окно рамок.

import { useRef, useState, type DragEvent, type ReactNode } from "react";
import * as api from "../../api/agents";
import { Button, Icon, Progress, Select, cx } from "../../ui";
import { count } from "../ru";
import { useConfirm } from "../mag/tasks/Confirm";
import { pictureTiles } from "./examplePick";
import PictureBoxes from "./PictureBoxes";

interface Upload { key: number; name: string; part: number; error?: string }

let seq = 0;

export default function PictureShelf({ lead, shelf, shelves, onShelf, pictures, onPictures, order, onToggle, color, busy }: {
  /** Переключатель источника — первым в строке полки. */
  lead: ReactNode;
  shelf: string;
  shelves: { name: string; count: number }[];
  onShelf: (name: string) => void;
  /** Картинки открытой полки. */
  pictures: api.Picture[];
  /** Правка общего списка картинок человека (все полки). */
  onPictures: (fn: (all: api.Picture[]) => api.Picture[]) => void;
  /** Номер в наборе по ключу рамки. */
  order: Map<string, number>;
  onToggle: (tile: api.ClassBox) => void;
  color?: string;
  busy: boolean;
}) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, confirmNode] = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const queue = useRef<{ key: number; file: File; shelf: string }[]>([]);
  const running = useRef(false);

  // По одной: сеть отдаётся первой картинке, и её полоса ходит честно.
  const pump = async () => {
    if (running.current) return;
    running.current = true;
    while (queue.current.length) {
      const job = queue.current.shift()!;
      const set = (patch: Partial<Upload>) => setUploads((old) => old.map((u) => (u.key === job.key ? { ...u, ...patch } : u)));
      try {
        const pic = await api.uploadPicture(job.file, job.shelf, (part) => set({ part }));
        onPictures((all) => [...all, pic]);
        setUploads((old) => old.filter((u) => u.key !== job.key));
      } catch (e) {
        set({ error: (e as Error).message });
      }
    }
    running.current = false;
  };

  const add = (files: File[]) => {
    setProblem(files.length > api.PICTURE_BATCH ? `За раз — не больше ${api.PICTURE_BATCH}; взяты первые ${api.PICTURE_BATCH}.` : null);
    const fresh: Upload[] = [];
    for (const file of files.slice(0, api.PICTURE_BATCH)) {
      const key = ++seq;
      const error = !api.PICTURE_TYPES.includes(file.type) ? "Это не JPEG, PNG или WebP."
        : file.size > api.PICTURE_MAX_BYTES ? "Больше 20 МБ — уменьшите и загрузите снова." : undefined;
      fresh.push({ key, name: file.name, part: 0, error });
      if (!error) queue.current.push({ key, file, shelf });
    }
    setUploads((old) => [...old, ...fresh]);
    void pump();
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!busy) add([...e.dataTransfer.files]);
  };
  const choose = () => input.current?.click();

  const remove = async (p: api.Picture) => {
    const ok = await confirm({ title: `Убрать «${p.file_name}» с полки?`, icon: "trash", danger: true, ok: "Убрать" });
    if (!ok) return;
    try {
      await api.deletePicture(p.id);
      onPictures((all) => all.filter((x) => x.id !== p.id));
    } catch (e) {
      setProblem((e as Error).message);
    }
  };

  const boxes = pictures.reduce((s, p) => s + p.boxes.length, 0);
  const bare = pictures.filter((p) => !p.boxes.length).length;
  const sending = uploads.filter((u) => !u.error).length;
  const failed = uploads.filter((u) => u.error).length;

  return (
    <section className={cx("ep-gal", over && "drop-on")} onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(false); }} onDrop={drop}>
      <input ref={input} type="file" multiple hidden accept={api.PICTURE_TYPES.join(",")}
        onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = ""; }} />
      <div className="ep-src">
        {lead}
        <Select label="Полка" size="sm" value={shelf} disabled={busy} onChange={onShelf}
          options={shelves.map((s) => ({ value: s.name, label: `${s.name} · ${s.count}` }))} />
        <Button size="sm" variant="outline" icon="upload" disabled={busy} onClick={choose}>Загрузить картинки</Button>
      </div>
      <div className="ep-tools">
        <span className="t-xs t-faint">
          {sending ? `Загружаю: осталось ${sending}${failed ? ` · ${count(failed, "отказ", "отказа", "отказов")}` : ""}`
            : <>{count(pictures.length, "картинка", "картинки", "картинок")} · {count(boxes, "рамка", "рамки", "рамок")}
              {bare > 0 && <span className="ep-warn-t"> · {bare} без рамки</span>}</>}
        </span>
        <span className="grow" />
        {pictures.length > 0 && <span className="t-xs t-faint">щелчок по рамке — в набор или из набора, номер — порядок</span>}
      </div>
      {problem && <p className="ep-warn">{problem}</p>}
      <div className="ep-grid-w">
        {!pictures.length && !uploads.length ? (
          <button type="button" className="ep-drop big" disabled={busy} onClick={choose}>
            <Icon name="upload" size={22} />
            <span>Перетащите картинки сюда или выберите файлы</span>
            <span className="t-xs t-faint">JPEG, PNG, WebP · до 20 МБ · до {api.PICTURE_BATCH} за раз</span>
          </button>
        ) : (
          <div className="ep-pgrid">
            {pictures.map((p, i) => (
              <Card key={p.id} p={p} order={order} color={color} onToggle={onToggle}
                onOpen={() => setEditing(i)} onRemove={() => void remove(p)} />
            ))}
            {uploads.map((u) => (
              <div key={u.key} className={cx("ep-pc", u.error ? "bad" : "busy")}>
                <div className="ep-pc-pic">
                  {u.error ? <span>{u.error}</span> : <Progress value={u.part} label={`Загрузка ${u.name}`} />}
                </div>
                <div className="ep-pc-f">
                  <span className="nm" title={u.name}>{u.name}</span><span className="grow" />
                  {u.error ? (
                    <button type="button" className="ep-x" aria-label="Убрать" onClick={() => setUploads((old) => old.filter((x) => x.key !== u.key))}>
                      <Icon name="x" size={12} />
                    </button>
                  ) : <span className="ct num">{Math.round(u.part * 100)}%</span>}
                </div>
              </div>
            ))}
            <button type="button" className="ep-drop" disabled={busy} onClick={choose}>
              <Icon name="upload" size={18} /><span>Перетащите ещё</span><span className="t-xs t-faint">JPEG, PNG, WebP · до 20 МБ</span>
            </button>
          </div>
        )}
      </div>
      {editing !== null && (
        <PictureBoxes pictures={pictures} start={editing} shelf={shelf} color={color} onClose={() => setEditing(null)}
          onSaved={(p) => onPictures((all) => all.map((x) => (x.id === p.id ? p : x)))}
          onDeleted={(id) => onPictures((all) => all.filter((x) => x.id !== id))} />
      )}
      {confirmNode}
    </section>
  );
}

/** Карточка картинки: рамки — плитки набора поверх неё. */
function Card({ p, order, color, onToggle, onOpen, onRemove }: {
  p: api.Picture; order: Map<string, number>; color?: string;
  onToggle: (tile: api.ClassBox) => void; onOpen: () => void; onRemove: () => void;
}) {
  const tiles = pictureTiles([p]);
  // Картинка целиком внутри карточки 4:3, рамки — долями её сторон.
  const wide = p.width / p.height >= 4 / 3;
  return (
    <div className={cx("ep-pc", !p.boxes.length && "empty")}>
      <div className="ep-pc-pic">
        <div className="ep-pc-in" style={{ aspectRatio: `${p.width} / ${p.height}`, ...(wide ? { width: "100%" } : { height: "100%" }) }}
          onClick={onOpen} title={p.boxes.length ? "Открыть рамки" : "Обвести рамкой"}>
          <img src={api.pictureImage(p.id, 480)} alt={p.file_name} loading="lazy" draggable={false} />
          {tiles.map((t) => {
            const at = order.get(t.uid);
            const [x, y, w, h] = t.box;
            return (
              <button key={t.uid} type="button" className={cx("ep-bx", at !== undefined && "on")} aria-pressed={at !== undefined}
                style={{ left: `${x / p.width * 100}%`, top: `${y / p.height * 100}%`, width: `${w / p.width * 100}%`,
                  height: `${h / p.height * 100}%`, borderColor: at !== undefined ? undefined : color }}
                title={at !== undefined ? `В наборе, № ${at + 1} — убрать` : `В набор · ${Math.round(w)}×${Math.round(h)}`}
                onClick={(e) => { e.stopPropagation(); onToggle(t); }}>
                {at !== undefined && <b>{at + 1}</b>}
              </button>
            );
          })}
          {!p.boxes.length && <span className="ep-pc-need">Обвести рамкой</span>}
        </div>
      </div>
      <div className="ep-pc-f">
        <span className="nm" title={`${p.file_name} · ${p.width}×${p.height}`}>{p.file_name}</span><span className="grow" />
        <span className={cx("ct", !p.boxes.length && "warn")}>{p.boxes.length ? count(p.boxes.length, "рамка", "рамки", "рамок") : "без рамки"}</span>
        <button type="button" className="ep-x" title="Рамки" aria-label={`Рамки «${p.file_name}»`} onClick={onOpen}>
          <Icon name="edit" size={13} />
        </button>
        <button type="button" className="ep-x" disabled={!!p.locked} title={p.locked ?? "Убрать с полки"}
          aria-label={`Убрать «${p.file_name}» с полки`} onClick={onRemove}>
          <Icon name={p.locked ? "lock" : "trash"} size={13} />
        </button>
      </div>
    </div>
  );
}
