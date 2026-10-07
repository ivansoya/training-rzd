// Окно «Образцы класса»: набор образцов «Сети по тексту» выбирается вручную из ручной разметки класса.
//
// Слева — все ручные рамки класса плитками, справа — набор по проходам и рядам и коллаж «как видит SAM 3».
// Набор неизменяем (training_svc/examples.py): «Сохранить» делает новый, строка узла переходит на него.
// Векторы YOLOE прежнего набора того же класса не пересчитываются (`from`).

import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import * as api from "../../api/agents";
import { Button, Check, Dialog, Icon, Notice, Popover, Seg, Select, Swatch, Switch, cx } from "../../ui";
import { count, ru } from "../ru";
import { EX_ROW, collagePasses, perPass, type TextModel } from "./agentDoc";
import {
  BANDS, MAX_SET, addFor, filterBoxes, moved, pickedOf, randomDistinct, sameName, stepFor, tilesOf, type Band, type Picked,
} from "./examplePick";

const PAGE = 54;
const WAIT_MS = 300;

export interface PickerPreview {
  /** Кадр превью агента: на нём коллаж «как видит SAM 3». */
  image: { id: string; width: number; height: number } | null;
  /** Вход SAM 3 узла и сторона тайла, если узел режет кадр. */
  side: number;
  tile: number | null;
}

export default function ExamplePicker({ model, agentClass, projects, set, preset, preview, onDone, onClose }: {
  model: TextModel;
  agentClass: { name: string; color?: string };
  projects: api.ClassSource[] | null;
  /** Нынешний набор строки: с него начинается выбор. */
  set?: api.ExampleSet;
  /** Класс-ссылка: проект (код) и класс проекта известны. */
  preset?: { project?: string; classId?: string };
  preview: PickerPreview;
  onDone: (set: api.ExampleSet) => void;
  onClose: () => void;
}) {
  const sam3 = model === "sam3";
  // Откуда рамки: класс-ссылка → класс набора → класс проекта с тем же именем.
  const start = useMemo(() => {
    const list = projects ?? [];
    if (preset?.project) return { project: preset.project, cls: preset.classId ?? "" };
    const own = list.find((p) => p.id === set?.project_id);
    if (own && set?.class_id) return { project: own.code, cls: set.class_id };
    for (const p of list) {
      const k = p.classes.find((c) => sameName(c.name, agentClass.name));
      if (k) return { project: p.code, cls: k.id };
    }
    return { project: list[0]?.code ?? "", cls: "" };
  }, [projects, preset, set, agentClass.name]);
  const [project, setProject] = useState(start.project);
  const [classId, setClassId] = useState(start.cls);
  useEffect(() => {
    setProject((p) => p || start.project);
    setClassId((c) => c || start.cls);
  }, [start]);

  const [boxes, setBoxes] = useState<api.ClassBox[] | null>(null);
  const [datasets, setDatasets] = useState<api.ExampleSources["datasets"]>([]);
  const [band, setBand] = useState<Band>("all");
  const [offDs, setOffDs] = useState<Set<string>>(new Set());
  const [merged, setMerged] = useState(true);
  const [limit, setLimit] = useState(PAGE);
  const [picked, setPicked] = useState<Picked[]>(() => (set?.items ?? []).map((it) => ({
    uid: it.uid, image_id: it.image_id, box: it.box, file_name: it.file_name,
  })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    setDatasets([]);
    setOffDs(new Set());
    api.exampleSources(project).then((r) => setDatasets(r.datasets)).catch(() => undefined);
  }, [project]);
  useEffect(() => {
    setBoxes(null);
    if (!project || !classId) return;
    let live = true;
    api.exampleBoxes(project, classId).then((r) => {
      if (!live) return;
      setBoxes(r.boxes);
      // Образцы набора, что есть в списке класса, получают группу — «Случайно» их учтёт.
      const byUid = new Map(r.boxes.map((b) => [b.uid, b]));
      setPicked((old) => old.map((p) => (byUid.has(p.uid) ? pickedOf(byUid.get(p.uid)!) : p)));
    }).catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [project, classId]);

  const proj = projects?.find((p) => p.code === project);
  const cls = proj?.classes.find((c) => c.id === classId);
  const pool = useMemo(() => filterBoxes(boxes ?? [], band, offDs), [boxes, band, offDs]);
  const tiles = useMemo(() => tilesOf(pool, merged), [pool, merged]);
  const order = new Map(picked.map((p, k) => [p.uid, k]));
  const add = addFor(model);

  const view = preview.image
    ? preview.tile ? [Math.min(preview.image.width, preview.tile), Math.min(preview.image.height, preview.tile)] : [preview.image.width, preview.image.height]
    : null;
  const passes = sam3 && view ? collagePasses(picked.length, view[0], view[1]) : [picked.map((_, k) => k)];
  // Плитка-кнопка в наборе: «+1», пока в последнем проходе есть место, иначе «+ проход». Обе берут случайную разную рамку.
  const cap = sam3 && view ? perPass(view[0], view[1]) : null;
  const last = passes[passes.length - 1] ?? [];
  const full = cap !== null && passes.length > 0 && last.length >= cap;
  const spare = randomDistinct(pool, picked, 1, () => 0).length > 0;
  const addOne = () => setPicked((old) => [...old, ...randomDistinct(pool, old, stepFor(model, old.length)).map(pickedOf)]);
  const plus = (label: string, title: string) => (
    <button type="button" className="ep-add" disabled={!spare} onClick={addOne}
      title={spare ? title : "Разных рамок под фильтр больше нет"}>
      <Icon name="plus" size={16} /><span>{label}</span>
    </button>
  );

  const toggle = (members: api.ClassBox[], rep: api.ClassBox) => {
    const inSet = members.filter((b) => order.has(b.uid));
    if (inSet.length) {
      const drop = new Set(inSet.map((b) => b.uid));
      setPicked((old) => old.filter((p) => !drop.has(p.uid)));
    } else setPicked((old) => [...old, pickedOf(rep)]);
  };
  const changeClass = (project: string, id: string) => {
    setProject(project);
    setClassId(id);
    setPicked([]);
    setLimit(PAGE);
  };

  const save = async () => {
    if (!cls || !picked.length) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.examplesByHand({
        project, class_id: cls.id, items: picked.map((p) => ({ image_id: p.image_id, box: p.box })),
        from: set && set.status === "ready" && set.class_id === cls.id ? set.id : undefined,
      });
      onDone(r.set);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const title = (
    <span className="ep-title">
      Образцы класса
      <span className="ep-cls"><Swatch color={agentClass.color} />{agentClass.name}</span>
    </span>
  );

  return (
    // Пока набор собирается на сервере, окно не закрывается.
    <Dialog open onOpenChange={(v) => !v && onClose()} closable={!busy} width={1560} height={900} bare title={title}
      className="ep"
      footer={<>
        <span className="t-xs t-muted">
          {sam3
            ? `Вырезка — авто, под размер в кадре · ${count(passes.length, "проход", "прохода", "проходов")} на кадр${passes.length > 1 && view ? " — каждый следующий ещё один вызов модели" : ""}`
            : "Вырезка — авто · YOLOE сводит набор в один средний вектор"}
        </span>
        <span className="grow" />
        <Button variant="ghost" disabled={busy} onClick={onClose}>Отмена</Button>
        <Button variant="primary" icon="images" disabled={busy || !cls || !picked.length} onClick={save}>
          {busy ? "Собираю…" : "Сохранить набор"}
        </Button>
      </>}>
      <div className="ep-b">
        <section className="ep-gal">
          <div className="ep-src">
            <Select label="Проект" size="sm" value={project || undefined} placeholder="Проект" disabled={busy}
              onChange={(v) => changeClass(v, projects?.find((p) => p.code === v)?.classes.find((c) => sameName(c.name, agentClass.name))?.id ?? "")}
              options={(projects ?? []).map((p) => ({ value: p.code, label: p.name }))} />
            <Select label="Класс проекта" size="sm" value={classId || undefined} placeholder="Класс проекта" disabled={busy || !proj}
              onChange={(v) => changeClass(project, v)} options={(proj?.classes ?? []).map((c) => ({ value: c.id, label: c.name }))} />
            {preset?.classId && <span className="t-xs t-faint">класс агента — ссылка на этот класс</span>}
          </div>
          <div className="ep-tools">
            <span className="ep-l">Размер</span>
            <Seg size="sm" label="Размер рамки" value={band} onChange={(v) => { setBand(v); setLimit(PAGE); }} options={BANDS} />
            <Popover align="start" width={280} trigger={
              <Button size="sm" icon="layers" disabled={!datasets.length}>
                {offDs.size ? `Датасеты: ${datasets.length - offDs.size} из ${datasets.length}` : "Датасеты: все"}
              </Button>}>
              <div className="ep-ds">
                {datasets.map((d) => (
                  <Check key={d.id} checked={!offDs.has(d.id)} onChange={(on) => setOffDs((old) => {
                    const next = new Set(old);
                    if (on) next.delete(d.id); else next.add(d.id);
                    return next;
                  })}>{d.name}</Check>
                ))}
              </div>
            </Popover>
            <label className="ep-flag">
              <Switch checked={merged} label="Похожие одной плиткой" onChange={setMerged} />
              похожие одной плиткой
            </label>
            <span className="grow" />
            {boxes && (
              <span className="t-xs t-faint">
                {count(pool.length, "ручная рамка", "ручные рамки", "ручных рамок")} · {count(new Set(pool.map((b) => b.image_id)).size, "кадр", "кадра", "кадров")}
              </span>
            )}
          </div>
          {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
          <div className="ep-grid-w">
            {!classId ? <p className="ep-none">Выберите класс проекта — его ручные рамки станут плитками.</p>
              : !boxes ? <p className="ep-none">Загружаю рамки…</p>
                : !tiles.length ? <p className="ep-none">{boxes.length ? "Под фильтр ничего не попало." : "У класса нет ручной разметки от 8 px."}</p>
                  : (
                    <div className="ep-grid">
                      {tiles.slice(0, limit).map((t) => {
                        const at = t.members.map((b) => order.get(b.uid)).find((k) => k !== undefined);
                        const [, , w, h] = t.box.box;
                        return (
                          <button key={t.box.uid} type="button" className={cx("ep-tile", at !== undefined && "on")} aria-pressed={at !== undefined}
                            title={`${t.box.file_name} — ${Math.round(w)}×${Math.round(h)}${t.members.length > 1 ? ` · тот же предмет на ${t.members.length} кадрах` : ""}`}
                            onClick={() => toggle(t.members, t.box)}>
                            <img src={api.boxCrop(t.box.image_id, t.box.box)} alt="" loading="lazy" draggable={false} />
                            {at !== undefined && <b>{at + 1}</b>}
                            {t.members.length > 1 && <em>×{t.members.length}</em>}
                            <span>{Math.round(w)}×{Math.round(h)}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
          </div>
          {tiles.length > 0 && (
            <div className="ep-more">
              <span className="t-xs t-faint">
                показано {ru(Math.min(limit, tiles.length))} из {ru(tiles.length)} · щелчок — в набор или из набора, номер — порядок
              </span>
              <span className="grow" />
              {limit < tiles.length && <Button size="sm" onClick={() => setLimit((l) => l + PAGE)}>Показать ещё</Button>}
            </div>
          )}
        </section>

        <section className="ep-side">
          <div className="ep-h">
            <b>Набор</b>
            <span className="t-xs t-faint">
              {count(picked.length, "образец", "образца", "образцов")}{sam3 ? ` · ${count(passes.length, "проход", "прохода", "проходов")}` : ""}
            </span>
            <span className="grow" />
            <Button size="sm" icon="shuffle" disabled={!pool.length}
              title="По одной рамке из разных предметов: тот же предмет на соседних кадрах ролика берётся один раз"
              onClick={() => setPicked((old) => [...old, ...randomDistinct(pool, old, Math.min(add, MAX_SET - old.length)).map(pickedOf)])}>
              {sam3 ? `Случайно +${add} разных` : "Все разные"}
            </Button>
            <Button size="sm" variant="ghost" disabled={!picked.length} onClick={() => setPicked([])}>Очистить</Button>
          </div>
          {picked.length === 0 && <p className="ep-none">Набор пуст: щёлкайте по плиткам слева или добирайте случайно.</p>}
          <div className="ep-passes">
            {(passes.length ? passes : [[]]).map((pass, p, all) => (
              <PassBlock key={p} label={sam3 ? `проход ${p + 1}${pass.length > EX_ROW ? " · 2 ряда" : ""}` : null}
                pass={pass} picked={picked} onMove={(a, b) => setPicked((old) => moved(old, a, b))}
                onDrop={(k) => setPicked((old) => old.filter((_, i) => i !== k))}
                onDropPass={pass.length ? () => setPicked((old) => old.filter((_, i) => !pass.includes(i))) : undefined}
                tail={p === all.length - 1 && !full ? (sam3 ? plus("+1", "Добавить одну случайную рамку другого предмета")
                  : plus("все", "Добавить все разные предметы класса: YOLOE сводит их в один средний вектор")) : null} />
            ))}
            {full && (
              <div className="ep-pass next">
                <div className="ep-pass-h"><span>проход {passes.length + 1}</span><span className="grow" /><span>ещё один вызов модели на кадр</span></div>
                <div className="ep-row">{plus("проход", "Начать следующий проход: добавить одну случайную рамку другого предмета")}</div>
              </div>
            )}
          </div>
          {sam3 && <Collage picked={picked} preview={preview} />}
        </section>
      </div>
    </Dialog>
  );
}

/** Один проход: миниатюры рядами по 6; порядок — перетаскиванием, × — убрать. */
function PassBlock({ label, pass, picked, onMove, onDrop, onDropPass, tail }: {
  label: string | null; pass: number[]; picked: Picked[];
  onMove: (from: number, to: number) => void; onDrop: (k: number) => void;
  /** Убрать проход целиком. */
  onDropPass?: () => void;
  /** Плитка-кнопка после последней миниатюры; полный ряд — она с новой строки. */
  tail?: ReactNode;
}) {
  const [over, setOver] = useState<number | null>(null);
  const rows: (number | "tail")[][] = Array.from({ length: Math.ceil(pass.length / EX_ROW) }, (_, k) => pass.slice(k * EX_ROW, (k + 1) * EX_ROW));
  if (tail) {
    if (!rows.length || rows[rows.length - 1].length >= EX_ROW) rows.push([]);
    rows[rows.length - 1].push("tail");
  }
  const dropOn = (to: number) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const from = Number(e.dataTransfer.getData("text/x-example"));
    if (Number.isInteger(from) && from !== to) onMove(from, to);
  };
  return (
    <div className="ep-pass">
      {label && (
        <div className="ep-pass-h">
          <span>{label}</span><span className="grow" /><span>порядок — перетаскиванием</span>
          {onDropPass && (
            <button type="button" className="ep-pass-x" onClick={onDropPass} aria-label={`Убрать ${label.split(" ·")[0]}`}
              title={`Убрать ${label.split(" ·")[0]}: ${pass.length} обр.`}><Icon name="x" size={12} /></button>
          )}
        </div>
      )}
      {rows.map((row, r) => (
        <div key={r} className="ep-row">
          {row.map((k) => {
            if (k === "tail") return <span key="tail" className="ep-tail">{tail}</span>;
            const p = picked[k];
            return (
              <div key={p.uid} className={cx("ep-th", over === k && "over")} draggable title={`${p.file_name} — ${Math.round(p.box[2])}×${Math.round(p.box[3])}`}
                onDragStart={(e) => { e.dataTransfer.setData("text/x-example", String(k)); e.dataTransfer.effectAllowed = "move"; }}
                onDragOver={(e) => { e.preventDefault(); setOver(k); }} onDragLeave={() => setOver((o) => (o === k ? null : o))}
                onDrop={dropOn(k)}>
                <img src={api.boxCrop(p.image_id, p.box)} alt={`образец ${k + 1}`} draggable={false} />
                <span className="n">{k + 1}</span>
                <button type="button" className="rm" aria-label={`Убрать образец ${k + 1}`} onClick={() => onDrop(k)}>×</button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** «Как видит SAM 3»: квадрат входа модели с рядами образцов над кадром превью. */
function Collage({ picked, preview }: { picked: Picked[]; preview: PickerPreview }) {
  const [pass, setPass] = useState(0);
  const [shot, setShot] = useState<{ url: string; passes: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  const key = JSON.stringify([preview.image?.id, preview.side, preview.tile, pass, picked.map((p) => [p.image_id, p.box])]);

  useEffect(() => {
    const image = preview.image;
    if (!image || !picked.length) {
      setShot(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const r = await api.exampleCollage({
          image_id: image.id, items: picked.map((p) => ({ image_id: p.image_id, box: p.box })),
          side: preview.side, tile: preview.tile, pass,
        }, ctrl.signal);
        const url = URL.createObjectURL(r.blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setShot({ url, passes: r.passes });
        setProblem(null);
        if (pass >= r.passes) setPass(r.passes - 1);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setProblem((e as Error).message);
      }
    }, WAIT_MS);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
    // Ключ собирает всё, от чего зависит картинка.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const n = shot?.passes ?? 1;
  return (
    <div className="ep-col">
      <div className="ep-h">
        <b>Как видит SAM 3</b>
        <span className="t-xs t-faint">
          {preview.image ? `на кадре превью, вход ${preview.side}${preview.tile ? ` · первый тайл ${preview.tile} px` : ""}` : "кадра превью нет"}
        </span>
        <span className="grow" />
        {n > 1 && (
          <Seg size="sm" label="Проход коллажа" value={String(Math.min(pass, n - 1))} onChange={(v) => setPass(Number(v))}
            options={Array.from({ length: n }, (_, k) => ({ value: String(k), label: `проход ${k + 1}` }))} />
        )}
      </div>
      <div className="ep-col-pic">
        {problem ? <span className="bad">{problem}</span>
          : !preview.image ? <span>Коллаж появится, когда превью агента посчитает кадр.</span>
            : !picked.length ? <span>Выберите образцы — здесь будет вход модели.</span>
              : shot ? <img src={shot.url} alt={`Вход SAM 3: образцы рядами над кадром, проход ${pass + 1}`} />
                : <span>Склеиваю…</span>}
      </div>
      {shot && <p className="t-xs t-faint">Квадрат {preview.side}×{preview.side}, как его получает модель; подсказки модели — тонкие рамки в клетках.</p>}
    </div>
  );
}
