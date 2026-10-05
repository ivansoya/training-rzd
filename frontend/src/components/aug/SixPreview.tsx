// «Превью на 6 кадрах»: выход графа на шести случайных кадрах — то, что ляжет в набор.

import { useEffect, useState } from "react";
import * as api from "../../api/aug";
import type { GraphDoc, PreviewResult } from "../../api/aug";
import { Button, Dialog, Icon, Switch } from "../../ui";
import { count } from "../ru";
import { Layer, type PreviewFrame } from "./NodePreview";

const N = 6;
type Cell = PreviewResult | { error: string } | null;

export default function SixPreview({ open, onClose, doc, node, nodeTitle, frame }: {
  open: boolean;
  onClose: () => void;
  doc: GraphDoc;
  node: string | null;
  nodeTitle: string;
  frame: PreviewFrame;
}) {
  const [round, setRound] = useState(0);
  const [cells, setCells] = useState<Cell[]>(() => Array(N).fill(null));
  const [before, setBefore] = useState(false);
  const project = frame.project;

  useEffect(() => {
    if (!open || !node || frame.projects === null) return;
    const stop = new AbortController();
    setCells(Array(N).fill(null));
    // Кадр не заказываем: сервер на каждый запрос берёт случайный размеченный.
    for (let i = 0; i < N; i++) {
      api.preview({ doc, node, seed: round * N + i, frame: project ? { project: project.code, image: null } : null }, stop.signal)
        .then((got) => setCells((old) => old.map((c, j) => (j === i ? got : c))))
        .catch((e: Error) => {
          if (e.name !== "AbortError") setCells((old) => old.map((c, j) => (j === i ? { error: e.message } : c)));
        });
    }
    return () => stop.abort();
    // Документ не меняется, пока окно открыто поверх холста.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, node, round, project?.code, frame.projects]);

  const desc = project
    ? `«${nodeTitle}» на шести случайных кадрах проекта «${project.name}» — то, что ляжет в набор`
    : `«${nodeTitle}» на тестовом кадре, шесть бросков жребия`;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()} width={1120} title="Превью на 6 кадрах" desc={desc}
      footer={<>
        <label className="ge-six-flag" htmlFor="six-before">
          <Switch id="six-before" checked={before} onChange={setBefore} />
          <span>Исходные кадры <span className="t-faint">— как было до графа</span></span>
        </label>
        <span className="grow" />
        <Button icon="refresh" onClick={() => setRound((r) => r + 1)}>Ещё 6 кадров</Button>
        <Button variant="primary" onClick={onClose}>Готово</Button>
      </>}>
      {!node ? (
        <p className="t-sm t-muted">В графе нет «Выхода» — показывать нечего.</p>
      ) : (
        <div className="ge-six">
          {cells.map((c, i) => {
            if (!c) return <div key={i} className="ge-six-c wait"><span>Считаю…</span></div>;
            if ("error" in c) return <div key={i} className="ge-six-c bad"><Icon name="alert" /><span>{c.error}</span></div>;
            const s = c.samples?.[0];
            if (!c.reached || !s) {
              return <div key={i} className="ge-six-c bad"><Icon name="route" /><span>{c.reached ? "Образцы потеряли разметку" : "Кадр до выхода не доходит"}</span></div>;
            }
            const view = before ? c.original! : s.after;
            return (
              <figure key={i} className="ge-six-c">
                <div className="ge-six-pic" style={{ aspectRatio: `${c.pics![view.pic].w} / ${c.pics![view.pic].h}` }}>
                  <Layer result={c} view={view} marks />
                </div>
                <figcaption>
                  <span className="t-ell">{c.frame.kind === "project" ? c.frame.name : "тестовый кадр"}</span>
                  <span className="ui-mono">{count(c.total ?? c.samples!.length, "образец", "образца", "образцов")}</span>
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
