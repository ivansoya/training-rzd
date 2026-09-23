// Превью узла: что выходит из выбранного узла, если пустить через граф один
// кадр. «Было» и «Стало» — в одном окне со шторкой.
//
// Считает сервер тем же исполнителем, что и сборку (dataprep_svc/preview.py):
// превью честное, и картинка здесь — та, что ляжет в набор. Отсюда «Другой
// жребий» вместо вероятностей, выкрученных в единицу.
//
// Показывается такт: каждый «Источник» выше узла получает свой кадр, как при
// сборке графа со «Слиянием сеткой». Выбранный кадр — первому источнику,
// остальным сервер подбирает свои от него.
//
// Пересчёт живой: на смену узла, кадра, жребия и на правку графа, через
// 300 мс после последнего движения. На сервер уходит черновик, а не версия —
// иначе правку не увидеть до «Сохранить версию». Прежний ответ остаётся на
// экране, пока не пришёл новый: мигание пустотой на каждом шаге ползунка
// читалось бы как поломка.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Node } from "@xyflow/react";
import * as api from "../../api/aug";
import type {
  CatalogueNode,
  GraphDoc,
  PreviewPic,
  PreviewResult,
  PreviewStep,
} from "../../api/aug";
import { titleOf, ru, type NodeData } from "./GraphNodes";
import Sep from "../Sep";

const WAIT_MS = 300;
const MIN_H = 220;
const DEFAULT_H = 380;

type Saved = { mode?: "project" | "test"; project?: string; image?: string | null };

// Хранилище браузера бывает недоступно (приватное окно) — тогда просто не
// помним, работать это не мешает.
function load<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function keep(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* не помним — не страшно */
  }
}

/** Подпись образца по его пути: «.1.0» — копии «Умножения», «.g0» — сетка. */
function sidLabel(sid: string): string {
  const parts = sid.split(".").filter(Boolean);
  const copies = parts.filter((p) => /^\d+$/.test(p)).map((p) => Number(p) + 1);
  const grids = parts.filter((p) => p.startsWith("g"));
  return [
    copies.length ? `копия ${copies.join(".")}` : "",
    grids.length ? "сетка" : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function Layer({
  result,
  view,
  marks,
  className,
}: {
  result: PreviewResult;
  view: PreviewPic;
  marks: boolean;
  className?: string;
}) {
  const pic = result.pics![view.pic];
  return (
    <div className={`g-pv-layer${className ? ` ${className}` : ""}`}>
      <img src={pic.url} alt="" draggable={false} />
      {/* Разметка в пикселях той самой картинки, что пришла: viewBox равен её
          размеру, и вписываются они одинаково — слой не может съехать. */}
      {marks && (
        <svg viewBox={`0 0 ${pic.w} ${pic.h}`} aria-hidden="true">
          {view.shapes.map((s, i) => {
            const cls = result.classes[s.c];
            const color = cls?.color ?? "#9998A9";
            const at = s.box
              ? [s.box[0], s.box[1]]
              : [
                  Math.min(...s.rings!.flat().map((p) => p[0])),
                  Math.min(...s.rings!.flat().map((p) => p[1])),
                ];
            return (
              <g key={i} stroke={color}>
                {s.box ? (
                  <rect x={s.box[0]} y={s.box[1]} width={s.box[2]} height={s.box[3]} />
                ) : (
                  s.rings!.map((ring, j) => (
                    <polygon key={j} points={ring.map((p) => p.join(",")).join(" ")} />
                  ))
                )}
                <text x={at[0]} y={at[1] - 5} fill={color}>
                  {cls?.name ?? `класс ${s.c}`}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

function Trail({
  steps,
  titleOfNode,
  opName,
}: {
  steps: PreviewStep[];
  titleOfNode: (id: string) => string | null;
  opName: (op: string) => string;
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
      if (owner)
        rows.push({ key: `g${i}`, name: titleOfNode(owner) ?? "Блок", value: "", state: "pass", inner: false });
    }
    if (step.cells !== undefined) {
      rows.push({
        key: `${i}`,
        name: (!inner && titleOfNode(step.node)) || "Слияние сеткой",
        value: `ячеек ${step.cells}`,
        state: "pass",
        inner,
      });
      return;
    }
    if (step.copy !== undefined) {
      rows.push({
        key: `${i}`,
        name: (!inner && titleOfNode(step.node)) || "Умножение",
        value: `копия ${step.copy + 1}`,
        state: "pass",
        inner,
      });
      return;
    }
    // Сработавшие считаются по счёту, а не по имени: в «Потоке» один и тот же
    // трансформ может стоять дважды.
    const left = [...(step.fired ?? [])];
    step.ops.forEach((op, j) => {
      const at = left.indexOf(op);
      if (at >= 0) left.splice(at, 1);
      const state = step.fired == null ? "pass" : at >= 0 ? "ok" : "miss";
      rows.push({
        key: `${i}.${j}`,
        name: opName(op),
        value: state === "ok" ? "сработал" : state === "miss" ? "не сработал" : "",
        state,
        inner,
      });
    });
  });
  if (!rows.length) return <p className="g-pv-none">Кадр не менялся</p>;
  return (
    <ol className="g-pv-route">
      {rows.map((r) => (
        <li key={r.key} className={`${r.state}${r.inner ? " inner" : ""}`}>
          <span className="dot" />
          <span className="n">{r.name}</span>
          <span className="v">{r.value}</span>
        </li>
      ))}
    </ol>
  );
}

export default function NodePreview({
  graphId,
  doc,
  nodes,
  byOp,
  watch,
  selected,
  onWatch,
  dropped,
  full,
  onFull,
}: {
  graphId: string;
  doc: GraphDoc;
  nodes: Node[];
  byOp: Map<string, CatalogueNode>;
  watch: string | null;
  selected: string | null;
  onWatch: (id: string) => void;
  /** Сколько образцов графа уходит в брошенные ветки — предупреждение
   *  переехало сюда из прежней полосы «Было/Стало». */
  dropped: number;
  full: boolean;
  onFull: (v: boolean) => void;
}) {
  const store = `aug-preview:${graphId}`;
  const [saved, setSaved] = useState<Saved>(() => load(store, {}));
  const [projects, setProjects] = useState<{ code: string; name: string; linked: boolean }[] | null>(null);
  const [seed, setSeed] = useState(0);
  const [base, setBase] = useState<"src" | "in">(() => load("aug-preview-base", "src"));
  const [marks, setMarks] = useState(() => load("aug-preview-marks", true));
  const [follow, setFollow] = useState(() => load("aug-preview-follow", false));
  const [height, setHeight] = useState(() => load("aug-preview-h", DEFAULT_H));
  const [variant, setVariant] = useState(0);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [x, setX] = useState(50);
  const shownKey = useRef("");
  const grab = useRef<{ y: number; h: number } | null>(null);

  useEffect(() => {
    api
      .previewProjects(graphId)
      .then((got) => setProjects(got.projects))
      .catch(() => setProjects([]));
  }, [graphId]);

  // «За выделением»: выделил узел на холсте — превью переходит на него.
  useEffect(() => {
    if (follow && selected && selected !== watch) onWatch(selected);
  }, [follow, selected, watch, onWatch]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n.data as NodeData])), [nodes]);
  const titleOfNode = (id: string) => {
    const d = byId.get(id);
    return d ? titleOf(d) : null;
  };
  const opName = (op: string) => byOp.get(op)?.name ?? op;

  // Кадр проекта — только из проектов, где у человека есть роль. Нет таких —
  // тестовый, и выбора нет.
  const canProject = Boolean(projects && projects.length);
  const project =
    canProject && saved.mode !== "test"
      ? projects!.find((p) => p.code === saved.project) ?? projects![0]
      : null;

  // Позиции узлов в запрос не идут: перетаскивание карточки не должно
  // пересчитывать превью.
  const shape = useMemo(
    () =>
      JSON.stringify({
        n: doc.nodes.map(({ pos: _pos, ...rest }) => rest),
        e: doc.edges,
      }),
    [doc]
  );

  const bodyFor = (image: string | null | undefined) => ({
    doc,
    node: watch!,
    seed,
    frame: project ? { project: project.code, image: image ?? null } : null,
  });
  const keyOf = (image: string | null | undefined) =>
    JSON.stringify([shape, watch, seed, project?.code, image ?? null]);

  useEffect(() => {
    if (!watch || projects === null) return;
    const image = project && saved.project === project.code ? saved.image : null;
    const key = keyOf(image);
    if (key === shownKey.current) return;
    const stop = new AbortController();
    const timer = window.setTimeout(async () => {
      setBusy(true);
      try {
        const got = await api.preview(bodyFor(image), stop.signal);
        // Случайный кадр пришёл со своим номером — запоминаем его, и этот же
        // ответ считается ответом на запрос с номером: второго не будет.
        const fixed = got.frame.image ?? null;
        shownKey.current = keyOf(project ? fixed : null);
        if (project && fixed !== image) {
          const next = { mode: "project" as const, project: project.code, image: fixed };
          setSaved(next);
          keep(store, next);
        }
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
    // bodyFor/keyOf собираются из перечисленного.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, watch, seed, project?.code, saved.image, projects]);

  const pick = (next: Saved) => {
    const merged = { ...saved, ...next };
    setSaved(merged);
    keep(store, merged);
  };

  const sample = result?.samples?.[variant];
  const before = sample ? (base === "src" ? result!.original! : sample.before) : null;
  const lost = sample && before ? before.objects - sample.after.objects : 0;
  const droppedHere = Object.entries(result?.dropped ?? {});

  function slide(e: ReactPointerEvent<HTMLDivElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    setX(Math.max(0, Math.min(100, ((e.clientX - box.left) / box.width) * 100)));
  }

  const frameText = result
    ? result.frame.kind === "project"
      ? [result.frame.project_name, result.frame.name, `${result.frame.width} × ${result.frame.height}`]
      : ["тестовый кадр", `${result.frame.width} × ${result.frame.height}`]
    : [];

  return (
    <section className={`g-pv${full ? " full" : ""}`} style={full ? undefined : { height }}>
      {!full && (
        <div
          className="g-pv-grip"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Высота превью"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            grab.current = { y: e.clientY, h: height };
          }}
          onPointerMove={(e) => {
            const g = grab.current;
            if (!g) return;
            const room = (e.currentTarget.parentElement?.parentElement?.clientHeight ?? 900) - 120;
            setHeight(Math.max(MIN_H, Math.min(g.h + g.y - e.clientY, room)));
          }}
          onPointerUp={() => {
            grab.current = null;
            keep("aug-preview-h", height);
          }}
        />
      )}

      <div className="g-pv-head">
        <label className="g-pv-pick">
          <span>Узел</span>
          <select
            className="g-pv-select strong"
            value={watch ?? ""}
            onChange={(e) => e.target.value && onWatch(e.target.value)}
            aria-label="Узел в превью"
          >
            {!watch && <option value="">не выбран</option>}
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {titleOf(n.data as NodeData)}
              </option>
            ))}
          </select>
        </label>
        <label className="g-pv-chk">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => {
              setFollow(e.target.checked);
              keep("aug-preview-follow", e.target.checked);
            }}
          />
          за выделением
        </label>
        <span className="g-pv-vsep" />
        <span className="g-pv-lbl">Было</span>
        <div className="g-pv-seg">
          {(
            [
              ["src", "исходный кадр"],
              ["in", "вход узла"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              aria-pressed={base === v}
              onClick={() => {
                setBase(v);
                keep("aug-preview-base", v);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="g-pv-vsep" />
        <button type="button" className="mag-ghost" disabled={!watch} onClick={() => setSeed((s) => s + 1)}>
          Другой жребий
        </button>
        <label className="g-pv-chk">
          <input
            type="checkbox"
            checked={marks}
            onChange={(e) => {
              setMarks(e.target.checked);
              keep("aug-preview-marks", e.target.checked);
            }}
          />
          разметка
        </label>
        <span className="g-pv-grow" />
        {dropped > 0 && (
          <span className="g-pv-warn">Брошенных веток: {ru(dropped)} образцов никуда не идут</span>
        )}
        <button
          type="button"
          className="mag-ghost g-pv-full"
          onClick={() => onFull(!full)}
          title={full ? "Вернуть холст" : "Во весь холст"}
          aria-label={full ? "Вернуть холст" : "Во весь холст"}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d={full ? "M5 1v4H1M9 1v4h4M5 13V9H1M9 13V9h4" : "M1 5V1h4M13 5V1H9M1 9v4h4M13 9v4H9"}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
          </svg>
        </button>
      </div>

      <div className="g-pv-body">
        <div className="g-pv-stage">
          {!watch ? (
            <p className="g-pv-empty">Выберите узел глазом на карточке или в списке «Узел»</p>
          ) : error ? (
            <p className="g-pv-empty mag-error">{error}</p>
          ) : !result ? (
            <p className="g-pv-empty">Считаю…</p>
          ) : !result.reached ? (
            <p className="g-pv-empty">Кадр до этого узла не доходит: нет провода от источника или у ветки нулевая доля</p>
          ) : !sample ? (
            <p className="g-pv-empty mag-error">
              Все образцы потеряли разметку
              {droppedHere.map(([id, n]) => (
                <span key={id}>
                  <Sep />
                  {titleOfNode(id.split("/")[0]) ?? id}: {n}
                </span>
              ))}
            </p>
          ) : (
            <div
              className={`g-pv-cmp${busy ? " busy" : ""}`}
              style={
                {
                  "--x": `${x}%`,
                  "--ar": `${result.pics![sample.after.pic].w} / ${result.pics![sample.after.pic].h}`,
                } as CSSProperties
              }
              tabIndex={0}
              role="slider"
              aria-label="Шторка «было — стало»"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(x)}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                slide(e);
              }}
              onPointerMove={(e) => e.buttons && slide(e)}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") setX((v) => Math.max(0, v - 5));
                if (e.key === "ArrowRight") setX((v) => Math.min(100, v + 5));
              }}
            >
              <Layer result={result} view={before!} marks={marks} />
              <Layer result={result} view={sample.after} marks={marks} className="after" />
              <div className="g-pv-bar">
                <span className="tag l">Было</span>
                <span className="tag r">Стало</span>
                <span className="knob" />
              </div>
              <span className="g-pv-stamp">
                {frameText.map((t, i) => (
                  <span key={i}>
                    {i > 0 && <Sep />}
                    {t}
                  </span>
                ))}
              </span>
            </div>
          )}
        </div>

        <aside className="g-pv-side">
          <section>
            <h5>Кадр</h5>
            <div className="g-pv-row">
              <div className="g-pv-seg">
                <button
                  type="button"
                  aria-pressed={Boolean(project)}
                  disabled={!canProject}
                  onClick={() => pick({ mode: "project" })}
                >
                  из проекта
                </button>
                <button type="button" aria-pressed={!project} onClick={() => pick({ mode: "test" })}>
                  тестовый
                </button>
              </div>
              {project && (
                <>
                  <select
                    className="g-pv-select wide"
                    value={project.code}
                    aria-label="Проект"
                    onChange={(e) => pick({ mode: "project", project: e.target.value, image: null })}
                  >
                    {projects!.map((p) => (
                      <option key={p.code} value={p.code}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="mag-ghost"
                    onClick={() => pick({ project: project.code, image: null })}
                  >
                    Другой кадр
                  </button>
                </>
              )}
            </div>
            {projects !== null && !canProject && <div className="g-pv-why">Нет проектов с размеченными кадрами</div>}
          </section>

          {result?.samples && result.samples.length > 0 && (
            <section>
              <h5>
                <span>Образцы на выходе</span>
                <span className="num">
                  {result.total! > result.samples.length
                    ? `${result.samples.length} из ${ru(result.total!)}`
                    : result.samples.length}
                </span>
              </h5>
              <div className="g-pv-film">
                {result.samples.map((s, i) => (
                  <button
                    key={i}
                    type="button"
                    aria-pressed={i === variant}
                    onClick={() => setVariant(i)}
                    aria-label={`Образец ${i + 1}`}
                  >
                    <img src={result.pics![s.after.pic].url} alt="" />
                    <span>
                      {i + 1}
                      {sidLabel(s.sid) && (
                        <>
                          <Sep />
                          {sidLabel(s.sid)}
                        </>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {sample && (
            <>
              <section>
                <h5>Путь образца</h5>
                <Trail steps={sample.trail} titleOfNode={titleOfNode} opName={opName} />
              </section>
              <section>
                <h5>Объекты</h5>
                <div className="g-pv-objs">
                  <b className="num">
                    {before!.objects} → {sample.after.objects}
                  </b>
                  <span>было → стало</span>
                </div>
                {lost > 0 && <div className="g-pv-warn block">Потеряно объектов: {lost}</div>}
                {droppedHere.length > 0 && (
                  <div className="g-pv-warn block">
                    Образцов без разметки, не дошли сюда:{" "}
                    {droppedHere.map(([id, n], i) => (
                      <span key={id}>
                        {i > 0 && <Sep />}
                        {titleOfNode(id.split("/")[0]) ?? id} — {n}
                      </span>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
