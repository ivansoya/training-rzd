// «Превью на 6 кадрах»: «Выход» агента на шести случайных кадрах проекта — то, что ляжет в разметку.
// Сервер считает их одним прогоном моделей; живое превью в шторке на это время замирает.

import { useEffect, useState } from "react";
import * as api from "../../api/agents";
import type { GraphDoc } from "../../api/aug";
import { Button, Dialog, Icon, Switch } from "../../ui";
import { count } from "../ru";
import { keep, load } from "../aug/NodePreview";
import AgentFrame from "./AgentFrame";

const N = 6;

export default function SixFrames({ open, onClose, graphId, doc, project, colorOf }: {
  open: boolean;
  onClose: () => void;
  graphId: string;
  doc: GraphDoc;
  project: { code: string; name: string } | null;
  colorOf: (cls: string) => string;
}) {
  const [round, setRound] = useState(0);
  const [got, setGot] = useState<api.PreviewFrames | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [human, setHuman] = useState(() => load("agent-preview-human", true));

  useEffect(() => {
    if (!open || !project) return;
    const stop = new AbortController();
    setGot(null);
    setError(null);
    const graph = { v: doc.v, nodes: doc.nodes.map(({ pos: _pos, ...n }) => n), edges: doc.edges };
    api.runPreviewFrames({ graph_id: graphId, doc: graph, project: project.code, count: N }, stop.signal)
      .then(setGot)
      .catch((e: Error & { payload?: { superseded?: boolean } }) => {
        if (e.name === "AbortError") return;
        setError(e.payload?.superseded ? "Запрос перебил другой — нажмите «Ещё 6 кадров»" : e.message);
      });
    return () => stop.abort();
    // Документ не меняется, пока окно открыто поверх холста.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, round, project?.code, graphId]);

  const desc = project ? `«Выход» агента на шести случайных кадрах проекта «${project.name}» — то, что ляжет в разметку` : "Нет проекта с кадрами";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()} width={1120} title="Превью на 6 кадрах" desc={desc}
      footer={<>
        <label className="ge-six-flag" htmlFor="ae-six-human">
          <Switch id="ae-six-human" checked={human} onChange={(v) => { setHuman(v); keep("agent-preview-human", v); }} />
          <span>Разметка человека</span>
        </label>
        {got && <span className="t-xs t-faint">{got.sequential ? "на карте поочерёдно" : "на карте"} · {got.ms} мс</span>}
        <span className="grow" />
        <Button icon="refresh" disabled={!got && !error} onClick={() => setRound((r) => r + 1)}>Ещё 6 кадров</Button>
        <Button variant="primary" onClick={onClose}>Готово</Button>
      </>}>
      {error ? (
        <div className="ge-no-prev bad"><Icon name="alert" size={22} /><span>{error}</span></div>
      ) : (
        <div className="ge-six">
          {(got?.frames ?? Array.from({ length: N }, () => null)).map((f, i) => !f ? (
            <div key={i} className="ge-six-c wait"><span>Считаю…</span></div>
          ) : (
            <figure key={f.image.id} className="ge-six-c">
              <AgentFrame image={f.image} layers={{ out: f.out, human: human ? f.human : [] }} colorOf={colorOf} />
              <figcaption>
                <span className="t-ell" title={f.image.file_name}>{f.image.file_name}</span>
                <span className="ui-mono">{count(f.out.length, "рамка", "рамки", "рамок")}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </Dialog>
  );
}
