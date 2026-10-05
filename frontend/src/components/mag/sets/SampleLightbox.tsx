// Образец набора поверх страницы: файл с разметкой, путь по графу, исходный кадр проекта.
// Правки здесь нет по смыслу: на наборе уже учились, «поправил один кадр» сделал бы прошлые обучения необъяснимыми.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { imagePreviewUrl } from "../../../auth/api";
import type { Sample } from "../../../api/trainsets";
import { Badge, Button, Icon, Seg, Swatch, useEscape } from "../../../ui";
import { ru } from "../../ru";
import ShapeMini from "../ShapeMini";

/** Путь образца словами. `sid` — номера копий через точку, у сетки — «g<k>». */
export function pathText(sid: string): string {
  return sid.split(".").filter(Boolean)
    .map((k) => (/^\d+$/.test(k) ? `копия ${Number(k) + 1}` : /^g\d+$/.test(k) ? `сетка ${Number(k.slice(1)) + 1}` : k))
    .join(" → ");
}

export function SampleLightbox({ items, index, total, src, code, names, onIndex, onClose, onNeedMore }: {
  items: Sample[];
  index: number;
  total: number;
  src: (s: Sample) => string;
  code: string;
  /** Имена трансформов по-русски из каталога узлов: «Rotate» → «Поворот». */
  names: Map<string, string>;
  onIndex: (i: number) => void;
  onClose: () => void;
  onNeedMore: () => void;
}) {
  const item = items[index];
  const [orig, setOrig] = useState(false);
  useEscape(onClose);

  const canPrev = index > 0;
  const canNext = index < total - 1;
  const go = useCallback((d: 1 | -1) => {
    const next = index + d;
    if (next < 0 || next >= total) return;
    if (next >= items.length) { onNeedMore(); return; }
    onIndex(next);
  }, [index, total, items.length, onIndex, onNeedMore]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [go]);

  if (!item) return null;
  const copy = item.ops.length > 0;
  const objects = new Map<string, { color: string; n: number }>();
  for (const b of item.boxes) {
    const o = objects.get(b.name);
    if (o) o.n += 1;
    else objects.set(b.name, { color: b.color, n: 1 });
  }

  return (
    <div className="lbx ts-lbx" role="dialog" aria-modal="true" aria-label={item.name}>
      <div className="lbx-h">
        <b className="lbx-name t-ell" title={item.name}>{item.source_name ?? item.name}</b>
        <Badge tone={item.split === "val" ? "var(--c2)" : "var(--c1)"}>{item.split}</Badge>
        {copy ? <Badge tone="var(--c4)" icon="workflow">{item.sid ? pathText(item.sid) : "копия графа"}</Badge>
          : <Badge>{item.hardlink ? "оригинал, ссылкой" : "оригинал"}</Badge>}
        <span className="grow" />
        <Seg label="Что показать" size="sm" value={orig ? "orig" : "sample"} onChange={(v) => setOrig(v === "orig")}
          options={[{ value: "sample", label: "Образец" }, { value: "orig", label: "Исходный кадр" }]} />
        <span className="t-xs t-faint ui-mono">{ru(index + 1)} из {ru(total)}</span>
        <Button variant="ghost" icon="x" aria-label="Закрыть" onClick={onClose} />
      </div>
      <div className="lbx-b">
        <button type="button" className="lbx-nav" onClick={() => go(-1)} disabled={!canPrev} aria-label="Предыдущий образец">
          <Icon name="chevL" />
        </button>
        <div className="lbx-stage ts-stage">
          {orig ? (
            <span className="ts-shot"><img src={imagePreviewUrl(item.image_id)} alt="Исходный кадр" /></span>
          ) : (
            <span className="ts-shot">
              <img src={src(item)} alt={item.name} />
              <ShapeMini boxes={item.boxes} width={item.width} height={item.height} />
            </span>
          )}
        </div>
        <button type="button" className="lbx-nav" onClick={() => go(1)} disabled={!canNext} aria-label="Следующий образец">
          <Icon name="chevR" />
        </button>
        <aside className="lbx-s ts-lbx-s">
          <section>
            <div className="lbx-st">Путь по графу</div>
            {copy ? (
              <ol className="ts-chain">
                <li><i />Исходный кадр</li>
                {item.ops.map((op, i) => <li key={i}><i />{names.get(op) ?? op}</li>)}
              </ol>
            ) : <p className="t-sm t-muted">Кадр лёг в набор как есть — {item.hardlink ? "жёсткой ссылкой на файл проекта" : "без трансформов"}.</p>}
          </section>
          <section>
            <div className="lbx-st"><span>Объекты</span><span className="ui-mono">{item.objects}</span></div>
            {objects.size ? [...objects].map(([name, o]) => (
              <div key={name} className="ts-obj"><Swatch color={o.color} /><span className="t-ell grow">{name}</span>
                <span className="ui-mono t-xs t-faint">{o.n > 1 ? `×${o.n}` : ""}</span></div>
            )) : <p className="t-sm t-muted">Фон: объектов нет, файл разметки пустой.</p>}
            {copy && !orig && <p className="t-xs t-faint">Рамки — как их прочтёт YOLO, после трансформов.</p>}
            {orig && <p className="t-xs t-faint">На исходном кадре рамки не рисуются: после трансформов они другие.</p>}
          </section>
          <section>
            <div className="lbx-st">Исходный кадр</div>
            {item.source_name && <span className="t-sm t-ell">{item.source_name}</span>}
            <Link className="t-sm" to={`/projects/${code}/datasets?frame=${item.image_id}`}>Открыть в датасете</Link>
            {item.width && item.height && <p className="t-xs t-faint">образец {item.width}×{item.height} px</p>}
          </section>
        </aside>
      </div>
    </div>
  );
}
