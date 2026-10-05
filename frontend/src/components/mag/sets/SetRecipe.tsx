// «Как собран»: что кладём → через что пропускаем → сколько вышло, по половинам; ниже датасеты и классы.

import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import type { ProjectDetail } from "../../../auth/api";
import type { Built, TrainSet } from "../../../api/trainsets";
import { Card, Chip, Icon, Meta } from "../../../ui";
import { count, ru } from "../../ru";
import { TRAIN, VAL } from "./sets";
import type { Flow } from "./sets";

export function SetRecipe({ set, flows, built, project }: {
  set: TrainSet;
  flows: Flow[];
  built: Built | null;
  project: ProjectDetail | null;
}) {
  const c = set.counts;
  const parts = (["train", "val"] as const).filter((p) => flows.some((f) => f.part === p));
  const frames = (p: "train" | "val") => built?.split?.[p] ?? null;
  const ds = set.spec.datasets ?? [];
  const pinned = set.spec.dataset_parts ?? {};
  const projectDs = new Map((project?.datasets ?? []).map((d) => [d.id, d]));
  const classesAll = project?.stats.classes ?? null;

  return (
    <Card title="Как собран" desc="что кладём → через что пропускаем → сколько вышло" className="ts-recipe">
      {parts.map((p) => (
        <div key={p} className="ts-part">
          <div className="ts-part-h">
            <i style={{ background: p === "train" ? TRAIN : VAL }} />
            <b>{p}</b>
            {frames(p) !== null && <span className="t-muted">{count(frames(p)!, "кадр", "кадра", "кадров")} проекта</span>}
            {c && <span className="t-faint">→ {count(c[p], "образец", "образца", "образцов")}</span>}
          </div>
          {flows.filter((f) => f.part === p).map((f, _i, all) => (
            // Старый набор без чисел по строкам: у единственной строки половины итог известен из счётчиков
            <FlowRow key={f.key} f={f.samples === null && all.length === 1 && c ? { ...f, samples: c[p] } : f} />
          ))}
        </div>
      ))}
      {!built && set.status === "ready" && (
        <p className="t-xs t-faint">Набор собран до того, как сборка начала считать образцы по строкам, — чисел у строк нет.</p>
      )}
      <div className="ts-recipe-f">
        <Meta items={[
          ["Датасеты", ds.length ? (
            <span className="ts-chips">
              {ds.map((id) => {
                const d = projectDs.get(id);
                return <Chip key={id} icon="images">
                  {d ? d.name : "удалён"}{d && <span className="ui-mono t-faint"> {ru(d.images_count)}</span>}
                  {pinned[id] && <span className="t-faint"> · только {pinned[id]}</span>}
                </Chip>;
              })}
            </span>
          ) : "—"],
          ["Классы", c ? `${c.classes}${classesAll ? ` из ${classesAll}` : ""} · номера — как в data.yaml` : "—"],
          ["Разметка", `${set.kind === "polygon" ? "контуры" : "рамки"}${c?.background ? ` · фон: ${count(c.background, "кадр", "кадра", "кадров")} без объектов, с пустым файлом` : ""}`],
        ]} />
      </div>
    </Card>
  );
}

function FlowRow({ f }: { f: Flow }) {
  const tone = { "--t": f.part === "train" ? TRAIN : VAL } as CSSProperties;
  const copies = f.images !== null && f.samples !== null ? f.samples - f.images : null;
  return (
    <div className="ts-flow">
      <div className="ts-node">
        <span className="ts-node-k"><Icon name={f.feed === "tags" ? "tag" : "images"} size={13} />
          {f.feed === "tags" ? "по тагу" : "половина"}{f.sourceName ? ` → «${f.sourceName}»` : ""}</span>
        <b className="t-ell">{f.source}</b>
        {f.images !== null && <small>{count(f.images, "кадр", "кадра", "кадров")}</small>}
      </div>
      <span className="ts-arr" aria-hidden="true" />
      {f.graph ? (
        <Link className="ts-node graph" to={`/augment/${f.graph.id}`} title="Открыть граф">
          <span className="ts-node-k"><Icon name="workflow" size={13} />граф аугментаций</span>
          <b className="t-ell">{f.graph.name} · v{f.graph.version}</b>
          {f.images && f.samples !== null ? <small>×{(f.samples / f.images).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}</small> : null}
        </Link>
      ) : (
        <div className="ts-node asis">
          <span className="ts-node-k"><Icon name="copy" size={13} />без графа</span>
          <b>как есть</b>
          <small>жёсткой ссылкой, места не занимает</small>
        </div>
      )}
      <span className="ts-arr" aria-hidden="true" />
      <div className="ts-node out" style={tone}>
        <span className="ts-node-k">в {f.part}</span>
        <b className="ui-mono">{f.samples !== null ? ru(f.samples) : "—"}</b>
        <small>{f.graph ? (copies !== null && copies > 0 ? `+ ${ru(copies)} к исходным` : "через граф") : "только оригиналы"}</small>
      </div>
    </div>
  );
}
