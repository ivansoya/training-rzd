// Окно «Рамки»: обвести объекты класса на своей картинке (решения 23.10.2026, макет d5).
//
// Рамки живут в пикселях файла; экран переводит мышь в них сам. Уход с картинки (← →, полоса, «Готово», Esc)
// сохраняет её рамки, если они изменились. Собранные наборы хранят свои копии рамок — правка их не трогает.

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import * as api from "../../api/agents";
import { Button, Dialog, Icon, Kbd, Notice, Swatch, cx } from "../../ui";
import { count } from "../ru";
import { useConfirm } from "../mag/tasks/Confirm";
import { boxAt, cornerAt, moveBox, resizeBox, sameBoxes, spanBox, tidy, usable } from "./pictureBox";
import type { Box, Corner, Point } from "./pictureBox";

// Допуск попадания в угол — в пикселях экрана.
const GRAB = 9;

type Drag =
  | { kind: "new"; from: Point }
  | { kind: "move"; k: number; from: Point; box: Box }
  | { kind: "size"; k: number; corner: Corner };

export default function PictureBoxes({ pictures, start, shelf, color, onSaved, onDeleted, onClose }: {
  /** Картинки полки по порядку плиток. */
  pictures: api.Picture[];
  start: number;
  shelf: string;
  color?: string;
  onSaved: (p: api.Picture) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
}) {
  const [at, setAt] = useState(Math.min(start, pictures.length - 1));
  const cur = pictures[at];
  const [boxes, setBoxes] = useState<Box[]>(cur?.boxes ?? []);
  const [sel, setSel] = useState(-1);
  const [ghost, setGhost] = useState<Box | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, confirmNode] = useConfirm();
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  // Рамки — с той картинки, что на экране; сменилась (переход, удаление) — берём её.
  useEffect(() => {
    setBoxes(cur?.boxes ?? []);
    setSel(-1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.id]);
  // Картинка ушла с полки (удалили) — окно встаёт на соседнюю или закрывается.
  useEffect(() => {
    if (!pictures.length) onClose();
    else if (at >= pictures.length) setAt(pictures.length - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pictures.length]);

  /** Сохранить рамки текущей, если изменились. false — не вышло, остаёмся. */
  const flush = async (): Promise<boolean> => {
    if (!cur || sameBoxes(boxes, cur.boxes)) return true;
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.savePictureBoxes(cur.id, boxes.map(tidy)));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const go = async (k: number) => {
    if (await flush()) setAt(Math.max(0, Math.min(pictures.length - 1, k)));
  };
  const close = async () => {
    if (await flush()) onClose();
  };
  const remove = async () => {
    if (!cur) return;
    const ok = await confirm({ title: `Убрать «${cur.file_name}» с полки?`, icon: "trash", danger: true, ok: "Убрать" });
    if (!ok) return;
    try {
      await api.deletePicture(cur.id);
      onDeleted(cur.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Мышь → пиксели файла.
  const point = (e: { clientX: number; clientY: number }): Point => {
    const r = wrap.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * cur.width, (e.clientY - r.top) / r.height * cur.height];
  };
  const tol = () => GRAB * cur.width / (wrap.current?.getBoundingClientRect().width || cur.width);

  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !cur) return;
    const p = point(e);
    const corner = sel >= 0 ? cornerAt(boxes[sel], p, tol()) : null;
    const hit = boxAt(boxes, p);
    if (corner) drag.current = { kind: "size", k: sel, corner };
    else if (hit >= 0) {
      setSel(hit);
      drag.current = { kind: "move", k: hit, from: p, box: boxes[hit] };
    } else {
      setSel(-1);
      drag.current = { kind: "new", from: p };
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !cur) return;
    const p = point(e);
    if (d.kind === "new") setGhost(spanBox(d.from, p, cur.width, cur.height));
    else setBoxes((old) => old.map((b, k) => (k !== d.k ? b
      : d.kind === "move" ? moveBox(d.box, p[0] - d.from[0], p[1] - d.from[1], cur.width, cur.height)
        : resizeBox(b, d.corner, p, cur.width, cur.height))));
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "new" && ghost && usable(ghost)) {
      setBoxes((old) => [...old, ghost]);
      setSel(boxes.length);
    }
    // Растянутую мельче 8 px не оставляем: сервер её всё равно отбросит.
    if (d?.kind === "size") setBoxes((old) => old.filter(usable));
    setGhost(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea")) return;
      if (e.key === "ArrowRight") void go(at + 1);
      else if (e.key === "ArrowLeft") void go(at - 1);
      else if ((e.key === "Delete" || e.key === "Backspace") && sel >= 0) {
        setBoxes((old) => old.filter((_, k) => k !== sel));
        setSel(-1);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!cur) return null;
  const pct = (b: Box) => ({ left: `${b[0] / cur.width * 100}%`, top: `${b[1] / cur.height * 100}%`,
    width: `${b[2] / cur.width * 100}%`, height: `${b[3] / cur.height * 100}%` });
  const title = (
    <span className="ep-title">
      Рамки <span className="ep-cls"><Swatch color={color} />{shelf}</span>
      <span className="t-xs t-faint ep-ed-of">{cur.file_name} · {cur.width}×{cur.height} · {at + 1} из {pictures.length}</span>
    </span>
  );

  return (
    <Dialog open onOpenChange={(v) => !v && void close()} width={1240} height={820} bare title={title} className="ep ep-ed"
      above={<div className="ep-ed-nav">
        <Button size="sm" variant="outline" icon="back" disabled={busy || at === 0} onClick={() => void go(at - 1)}>Назад</Button>
        <Button size="sm" variant="outline" disabled={busy || at === pictures.length - 1} onClick={() => void go(at + 1)}>
          Дальше <Icon name="forward" size={14} />
        </Button>
      </div>}>
      <div className="ep-ed-b">
        <div className="ep-ed-cv">
          <div ref={wrap} className="ep-ed-wrap" style={{ "--ar": cur.width / cur.height } as CSSProperties}
            onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
            <img src={api.pictureImage(cur.id, 1600)} alt={cur.file_name} draggable={false} />
            {boxes.map((b, k) => (
              <div key={k} className={cx("ep-bx", k === sel && "sel")} style={{ ...pct(b), borderColor: k === sel ? undefined : color }}>
                {k === sel && (["nw", "ne", "sw", "se"] as Corner[]).map((c) => <span key={c} className={`ep-hd ${c}`} />)}
              </div>
            ))}
            {ghost && <div className="ep-bx sel" style={pct(ghost)} />}
          </div>
        </div>
        <div className="ep-ed-side">
          <b>{boxes.length ? count(boxes.length, "рамка", "рамки", "рамок") : "Рамок нет"}</b>
          {!boxes.length && <p className="ep-warn">Без рамки картинка в набор не попадёт.</p>}
          <div className="ep-bl-list">
            {boxes.map((b, k) => (
              <div key={k} className={cx("ep-bl", k === sel && "sel")} onClick={() => setSel(k)}>
                <Swatch color={color} /><span className="t-ell">{shelf}</span><span className="grow" />
                <span className="t-xs t-faint num">{Math.round(b[2])}×{Math.round(b[3])}</span>
                <button type="button" className="ep-x" aria-label={`Удалить рамку ${k + 1}`}
                  onClick={(e) => { e.stopPropagation(); setBoxes((old) => old.filter((_, i) => i !== k)); setSel(-1); }}>
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
          </div>
          {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
          <span className="grow" />
          <div className="ep-keys t-xs t-faint">
            <span><Kbd>мышь</Kbd> новая рамка</span>
            <span><Kbd>Del</Kbd> удалить выбранную</span>
            <span><Kbd>← →</Kbd> соседняя картинка</span>
          </div>
          <Button size="sm" variant="danger" icon={cur.locked ? "lock" : "trash"} disabled={busy || !!cur.locked}
            title={cur.locked ?? undefined} onClick={() => void remove()}>Удалить картинку</Button>
          <Button variant="primary" disabled={busy} onClick={() => void close()}>{busy ? "Сохраняю…" : "Готово"}</Button>
        </div>
      </div>
      <div className="ep-strip">
        {pictures.map((p, k) => (
          <button key={p.id} type="button" className={cx(k === at && "cur", !p.boxes.length && "nb")}
            title={`${p.file_name}${p.boxes.length ? "" : " — без рамки"}`} onClick={() => void go(k)}>
            <img src={api.pictureImage(p.id, 160)} alt="" loading="lazy" draggable={false} />
          </button>
        ))}
      </div>
      {confirmNode}
    </Dialog>
  );
}
