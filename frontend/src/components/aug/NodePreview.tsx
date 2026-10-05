// Превью узла с глазом: что выходит из него, если пустить через граф один кадр.
// «До» и «после» — в одном окне со шторкой.
//
// Считает сервер тем же исполнителем, что и сборку (dataprep_svc/preview.py):
// картинка здесь — та, что ляжет в набор. Отсюда «Другой жребий» вместо
// вероятностей, выкрученных в единицу.
//
// Пересчёт живой: на смену узла, кадра, жребия и на правку графа, через
// 300 мс после последнего движения. На сервер уходит черновик, а не версия.
// Прежний ответ остаётся на экране, пока не пришёл новый.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Node } from "@xyflow/react";
import * as api from "../../api/aug";
import type { CatalogueNode, GraphDoc, PreviewPic, PreviewResult, PreviewStep } from "../../api/aug";
import { Button, Dialog, Field, Icon, Popover, Seg, Select, Switch, cx } from "../../ui";
import { titleOf, ru, type NodeData } from "./GraphNodes";

const WAIT_MS = 300;

type Saved = { mode?: "project" | "test"; project?: string; image?: string | null };

// Хранилище браузера бывает недоступно (приватное окно) — тогда просто не помним.
export function load<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
export function keep(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* не помним — не страшно */
  }
}

export type PreviewFrame = ReturnType<typeof usePreviewFrame>;

/** Откуда берётся кадр превью: проект (из тех, где есть роль) или тестовый. Помнится на граф. */
export function usePreviewFrame(graphId: string) {
  const store = `aug-preview:${graphId}`;
  const [saved, setSaved] = useState<Saved>(() => load(store, {}));
  const [projects, setProjects] = useState<{ code: string; name: string; linked: boolean }[] | null>(null);

  useEffect(() => {
    api.previewProjects(graphId).then((got) => setProjects(got.projects)).catch(() => setProjects([]));
  }, [graphId]);

  const canProject = Boolean(projects && projects.length);
  const project = canProject && saved.mode !== "test"
    ? projects!.find((p) => p.code === saved.project) ?? projects![0]
    : null;
  const pick = (next: Saved) => {
    const merged = { ...saved, ...next };
    setSaved(merged);
    keep(store, merged);
  };
  return { saved, projects, canProject, project, pick };
}

/** Подпись образца по его пути: «.1.0» — копии «Умножения», «.g0» — сетка. */
function sidLabel(sid: string): string {
  const parts = sid.split(".").filter(Boolean);
  const copies = parts.filter((p) => /^\d+$/.test(p)).map((p) => Number(p) + 1);
  const grids = parts.filter((p) => p.startsWith("g"));
  return [copies.length ? `копия ${copies.join(".")}` : "", grids.length ? "сетка" : ""].filter(Boolean).join(", ");
}

export function Layer({ result, view, marks, className }: {
  result: PreviewResult; view: PreviewPic; marks: boolean; className?: string;
}) {
  const pic = result.pics![view.pic];
  return (
    <div className={cx("ge-layer", className)}>
      <img src={pic.url} alt="" draggable={false} />
      {/* viewBox равен размеру картинки, вписываются одинаково — слой не съедет. */}
      {marks && (
        <svg viewBox={`0 0 ${pic.w} ${pic.h}`} aria-hidden="true">
          {view.shapes.map((s, i) => {
            const cls = result.classes[s.c];
            const color = cls?.color ?? "var(--faint)";
            const at = s.box
              ? [s.box[0], s.box[1]]
              : [Math.min(...s.rings!.flat().map((p) => p[0])), Math.min(...s.rings!.flat().map((p) => p[1]))];
            return (
              <g key={i} stroke={color}>
                {s.box ? <rect x={s.box[0]} y={s.box[1]} width={s.box[2]} height={s.box[3]} />
                  : s.rings!.map((ring, j) => <polygon key={j} points={ring.map((p) => p.join(",")).join(" ")} />)}
                <text x={at[0]} y={at[1] - 5} fill={color}>{cls?.name ?? `класс ${s.c}`}</text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

function Trail({ steps, titleOfNode, opName }: {
  steps: PreviewStep[]; titleOfNode: (id: string) => string | null; opName: (op: string) => string;
}) {
  const rows: { key: string; name: string; value: string; state: string; inner: boolean }[] = [];
  let group: string | null = null;
  steps.forEach((step, i) => {
    const slash = step.node.indexOf("/");
    const inner = slash > 0;
    // Блок стоит в пути одной строкой, под ней — его внутренности.
    const owner = inner ? step.node.slice(0, slash) : null;
    if (owner !== group) {
      group = owner;
      if (owner) rows.push({ key: `g${i}`, name: titleOfNode(owner) ?? "Блок", value: "", state: "pass", inner: false });
    }
    if (step.cells !== undefined) {
      rows.push({ key: `${i}`, name: (!inner && titleOfNode(step.node)) || "Слияние сеткой", value: `ячеек ${step.cells}`, state: "pass", inner });
      return;
    }
    if (step.copy !== undefined) {
      rows.push({ key: `${i}`, name: (!inner && titleOfNode(step.node)) || "Умножение", value: `копия ${step.copy + 1}`, state: "pass", inner });
      return;
    }
    // Сработавшие считаются по счёту, а не по имени: в «Потоке» трансформ может стоять дважды.
    const left = [...(step.fired ?? [])];
    step.ops.forEach((op, j) => {
      const at = left.indexOf(op);
      if (at >= 0) left.splice(at, 1);
      const state = step.fired == null ? "pass" : at >= 0 ? "ok" : "miss";
      rows.push({ key: `${i}.${j}`, name: opName(op), value: state === "ok" ? "сработал" : state === "miss" ? "не сработал" : "", state, inner });
    });
  });
  if (!rows.length) return <p className="t-xs t-faint">Кадр не менялся</p>;
  return (
    <ol className="ge-route">
      {rows.map((r) => (
        <li key={r.key} className={cx(r.state, r.inner && "inner")}>
          <span className="dot" />
          <span className="n">{r.name}</span>
          <span className="v">{r.value}</span>
        </li>
      ))}
    </ol>
  );
}

/** Шторка «до/после»: тянется мышью и стрелками. */
export function Curtain({ result, before, after, marks, busy, caption, onOpen }: {
  result: PreviewResult; before: PreviewPic; after: PreviewPic; marks: boolean; busy?: boolean; caption?: ReactNode;
  /** Двойной щелчок — во весь экран. */
  onOpen?: () => void;
}) {
  const [x, setX] = useState(50);
  const slide = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setX(Math.max(0, Math.min(100, ((e.clientX - box.left) / box.width) * 100)));
  };
  const pic = result.pics![after.pic];
  return (
    <div className={cx("ge-cmp", busy && "busy")} tabIndex={0} role="slider" aria-label="Шторка «до — после»"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(x)}
      style={{ "--x": `${x}%`, "--ar": `${pic.w} / ${pic.h}`, "--arn": pic.w / pic.h } as CSSProperties}
      onDoubleClick={onOpen}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); slide(e); }}
      onPointerMove={(e) => e.buttons && slide(e)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") setX((v) => Math.max(0, v - 5));
        if (e.key === "ArrowRight") setX((v) => Math.min(100, v + 5));
      }}>
      <Layer result={result} view={before} marks={marks} />
      <Layer result={result} view={after} marks={marks} className="after" />
      <span className="ge-cap l">до</span>
      <span className="ge-cap r">после</span>
      <span className="ge-knob" />
      {caption && <span className="ge-stamp">{caption}</span>}
    </div>
  );
}

export default function NodePreview({ frame, doc, nodes, byOp, watch, pinned, onPin, summary }: {
  frame: PreviewFrame;
  doc: GraphDoc;
  nodes: Node[];
  byOp: Map<string, CatalogueNode>;
  /** Узел в превью: закреплённый глазом, иначе выделенный. */
  watch: string | null;
  pinned: boolean;
  /** Закрепить узел или открепить (null). */
  onPin: (id: string | null) => void;
  /** Сводка графа — первой строкой колонки «Что получится». */
  summary: ReactNode;
}) {
  const { saved, projects, canProject, project, pick } = frame;
  const [seed, setSeed] = useState(0);
  const [base, setBase] = useState<"src" | "in">(() => load("aug-preview-base", "src"));
  const [marks, setMarks] = useState(() => load("aug-preview-marks", true));
  const [variant, setVariant] = useState(0);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState(false);
  const shownKey = useRef("");

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n.data as NodeData])), [nodes]);
  const titleOfNode = (id: string) => {
    const d = byId.get(id);
    return d ? titleOf(d) : null;
  };
  const opName = (op: string) => byOp.get(op)?.name ?? op;

  // Позиции узлов в запрос не идут: перетаскивание карточки превью не пересчитывает.
  const shape = useMemo(
    () => JSON.stringify({ n: doc.nodes.map(({ pos: _pos, ...rest }) => rest), e: doc.edges }),
    [doc]
  );
  const keyOf = (image: string | null | undefined) => JSON.stringify([shape, watch, seed, project?.code, image ?? null]);

  useEffect(() => {
    if (!watch || projects === null) return;
    const image = project && saved.project === project.code ? saved.image : null;
    const key = keyOf(image);
    if (key === shownKey.current) return;
    const stop = new AbortController();
    const timer = window.setTimeout(async () => {
      setBusy(true);
      try {
        const got = await api.preview({ doc, node: watch, seed, frame: project ? { project: project.code, image: image ?? null } : null }, stop.signal);
        // Случайный кадр пришёл со своим номером — запоминаем его, второго запроса не будет.
        const fixed = got.frame.image ?? null;
        shownKey.current = keyOf(project ? fixed : null);
        if (project && fixed !== image) pick({ mode: "project", project: project.code, image: fixed });
        setResult(got);
        setError(null);
        setVariant((v) => (v < (got.samples?.length ?? 0) ? v : 0));
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError((e as Error).message);
      } finally {
        if (!stop.signal.aborted) setBusy(false);
      }
    }, WAIT_MS);
    return () => {
      window.clearTimeout(timer);
      stop.abort();
    };
    // keyOf и pick собираются из перечисленного.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, watch, seed, project?.code, saved.image, projects]);

  const sample = result?.samples?.[variant];
  const before = sample ? (base === "src" ? result!.original! : sample.before) : null;
  const lost = sample && before ? before.objects - sample.after.objects : 0;
  const droppedHere = Object.entries(result?.dropped ?? {});
  const frameText = result
    ? result.frame.kind === "project"
      ? `${result.frame.name} · ${result.frame.width} × ${result.frame.height}`
      : `тестовый кадр · ${result.frame.width} × ${result.frame.height}`
    : "";

  const settings = (
    <Popover align="end" width={300} trigger={<Button size="sm" variant="ghost" icon="settings" aria-label="Настройки превью" />}>
      <div className="ge-pv-set">
        <Field label="Кадр">
          {() => (
            <Seg<"project" | "test"> size="sm" label="Кадр" value={project ? "project" : "test"}
              onChange={(v) => pick({ mode: v })}
              options={[{ value: "project", label: "из проекта", disabled: !canProject }, { value: "test", label: "тестовый" }]} />
          )}
        </Field>
        {project && (
          <Field label="Проект">
            {(id) => (
              <Select id={id} full size="sm" label="Проект" value={project.code}
                onChange={(v) => pick({ mode: "project", project: v, image: null })}
                options={projects!.map((p) => ({ value: p.code, label: p.name, hint: p.linked ? "граф подключён" : undefined }))} />
            )}
          </Field>
        )}
        {projects !== null && !canProject && <p className="t-xs t-faint">Нет проектов с размеченными кадрами — только тестовый.</p>}
        <Field label="«До» — это">
          {() => (
            <Seg<"src" | "in"> size="sm" label="До" value={base} onChange={(v) => { setBase(v); keep("aug-preview-base", v); }}
              options={[{ value: "src", label: "исходный кадр" }, { value: "in", label: "вход узла" }]} />
          )}
        </Field>
        <div className="ge-flag">
          <span>Разметка поверх кадра</span>
          <Switch checked={marks} label="Разметка" onChange={(v) => { setMarks(v); keep("aug-preview-marks", v); }} />
        </div>
      </div>
    </Popover>
  );

  return (
    <>
      <section className="ge-sec ge-pv">
        <div className="ge-sec-h">
          {/* Выбор в списке закрепляет узел, как глаз на карточке. */}
          <Select size="sm" icon={pinned ? "eye" : "pointer"} label="Узел в превью" value={watch ?? undefined} placeholder="Узел не выбран"
            onChange={(id) => onPin(id)} options={nodes.map((n) => ({ value: n.id, label: titleOf(n.data as NodeData) }))} />
          {watch && (
            <Button size="sm" variant="ghost" icon="eye" className={pinned ? "ge-pin on" : "ge-pin"} aria-pressed={pinned}
              onClick={() => onPin(pinned ? null : watch)}
              title={pinned ? "Открепить — превью снова пойдёт за выделением" : "Закрепить: превью останется на этом узле"}>
              {pinned ? "Закреплён" : "За выделением"}
            </Button>
          )}
          <span className="grow" />
          <Button size="sm" variant="ghost" icon="shuffle" disabled={!watch} onClick={() => setSeed((s) => s + 1)}
            title="Тот же кадр, другой бросок вероятностей">Другой жребий</Button>
          {settings}
          <Button size="sm" variant="ghost" icon="fit" disabled={!sample} aria-label="Превью во весь экран" onClick={() => setFull(true)} />
        </div>
        <div className="ge-pv-stage">
          {!watch ? (
            <div className="ge-no-prev"><Icon name="pointer" size={22} /><span>Выберите узел на холсте — здесь появится, что из него выходит. Глаз на карточке закрепляет узел</span></div>
          ) : error ? (
            <div className="ge-no-prev bad"><Icon name="alert" size={22} /><span>{error}</span></div>
          ) : !result ? (
            <div className="ge-no-prev"><span>Считаю…</span></div>
          ) : !result.reached ? (
            <div className="ge-no-prev"><Icon name="route" size={22} /><span>Кадр до этого узла не доходит: нет провода от источника или у ветки нулевая доля</span></div>
          ) : !sample ? (
            <div className="ge-no-prev bad"><Icon name="alert" size={22} /><span>Все образцы потеряли разметку</span></div>
          ) : (
            <Curtain result={result} before={before!} after={sample.after} marks={marks} busy={busy} onOpen={() => setFull(true)} />
          )}
        </div>
        {result && (
          <div className="ge-pv-f">
            <span className="t-ell">{frameText}</span>
            {project && (
              <Button size="sm" variant="ghost" icon="refresh" onClick={() => pick({ project: project.code, image: null })}>Другой кадр</Button>
            )}
          </div>
        )}
      </section>

      <section className="ge-sec ge-out">
        <div className="ge-sec-h"><b>Что получится</b></div>
        {summary}
        {result?.samples && result.samples.length > 1 && (
          <div className="ge-out-b">
            <span className="ge-out-t">
              Образцы на выходе узла
              <span className="ui-mono">{result.total! > result.samples.length ? `${result.samples.length} из ${ru(result.total!)}` : result.samples.length}</span>
            </span>
            <div className="ge-film">
              {result.samples.map((s, i) => (
                <button key={i} type="button" aria-pressed={i === variant} onClick={() => setVariant(i)}
                  aria-label={`Образец ${i + 1}`} title={sidLabel(s.sid) || `Образец ${i + 1}`}>
                  <img src={result.pics![s.after.pic].url} alt="" />
                  <span>{i + 1}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {sample && (
          <>
            <div className="ge-out-b">
              <span className="ge-out-t">Путь образца</span>
              <Trail steps={sample.trail} titleOfNode={titleOfNode} opName={opName} />
            </div>
            <div className="ge-out-b">
              <span className="ge-out-t">Объекты <span className="ui-mono">{before!.objects} → {sample.after.objects}</span></span>
              {lost > 0 && <p className="ge-loose"><Icon name="alert" size={14} />Потеряно объектов: {lost}</p>}
            </div>
          </>
        )}
        {droppedHere.length > 0 && (
          <p className="ge-loose"><Icon name="alert" size={14} />
            Без разметки и не дошли сюда: {droppedHere.map(([id, n]) => `${titleOfNode(id.split("/")[0]) ?? id} — ${n}`).join(", ")}
          </p>
        )}
        <p className="t-xs t-faint">Встроенные аугментации ultralytics при обучении на наборе с графом выключаются.</p>
      </section>

      {/* Во весь экран: та же шторка и те же жребий и кадр — выбранное остаётся и после закрытия. */}
      <Dialog open={full && Boolean(sample)} onOpenChange={setFull} width={4000} height={4000} bare className="ge-full"
        title={watch ? titleOfNode(watch) ?? "Превью" : "Превью"} desc={frameText}>
        {result && sample && (
          <div className="ge-full-b">
            <div className="ge-full-stage">
              <Curtain result={result} before={before!} after={sample.after} marks={marks} busy={busy} />
            </div>
            <div className="ge-full-bar">
              <Button icon="shuffle" onClick={() => setSeed((v) => v + 1)} title="Тот же кадр, другой бросок вероятностей">Другой жребий</Button>
              {project && <Button icon="refresh" onClick={() => pick({ project: project.code, image: null })}>Другой кадр</Button>}
              <label className="ge-six-flag" htmlFor="full-marks">
                <Switch id="full-marks" checked={marks} onChange={(v) => { setMarks(v); keep("aug-preview-marks", v); }} />
                <span>Разметка</span>
              </label>
              <span className="grow" />
              {result.samples!.length > 1 && (
                <div className="ge-film row" role="group" aria-label="Образцы на выходе узла">
                  {result.samples!.map((smp, i) => (
                    <button key={i} type="button" aria-pressed={i === variant} onClick={() => setVariant(i)}
                      aria-label={`Образец ${i + 1}`} title={sidLabel(smp.sid) || `Образец ${i + 1}`}>
                      <img src={result.pics![smp.after.pic].url} alt="" />
                      <span>{i + 1}</span>
                    </button>
                  ))}
                </div>
              )}
              <span className="t-xs t-faint">← → — шторка</span>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
