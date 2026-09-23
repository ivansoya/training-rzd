// Полка весов: выбрать для узла «Сеть», загрузить свой .pt, взять из обучения.
//
// Файл с чужим кодом внутри сервер отвергает до того, как его откроет torch
// (training_svc/pt_guard.py) — его ответ показывается как есть.

import { useEffect, useState } from "react";
import * as api from "../../api/agents";
import Sep from "../Sep";
import { useBackdrop } from "../useBackdrop";

const mb = (bytes: number | null | undefined) =>
  bytes ? `${(bytes / (1 << 20)).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ` : "—";

export default function WeightsPicker({
  current,
  onPick,
  onClose,
}: {
  current?: string | null;
  onPick: (w: api.Weights) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"shelf" | "runs">("shelf");
  const [shelf, setShelf] = useState<api.Weights[] | null>(null);
  const [runs, setRuns] = useState<api.TrainedRun[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api.listWeights().then((r) => setShelf(r.weights)).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (tab === "runs" && runs === null)
      api.trainedRuns().then((r) => setRuns(r.runs)).catch((e) => setError(e.message));
  }, [tab, runs]);

  const take = async (work: () => Promise<api.Weights>, label: string) => {
    setBusy(label);
    setError(null);
    try {
      onPick(await work());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (w: api.Weights) => {
    setError(null);
    try {
      await api.deleteWeights(w.id);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="mag-backdrop" {...useBackdrop(onClose)}>
      <div className="mag-modal ag-picker" onClick={(e) => e.stopPropagation()}>
        <h1>Веса для сети</h1>
        <div className="ag-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "shelf"} onClick={() => setTab("shelf")}>
            Моя полка {shelf ? <span className="mono">{shelf.length}</span> : null}
          </button>
          <button type="button" role="tab" aria-selected={tab === "runs"} onClick={() => setTab("runs")}>
            Из обучения
          </button>
          <label className="mag-ghost ag-upload">
            {busy === "upload" ? "Загружаю…" : "Загрузить .pt"}
            <input
              type="file"
              accept=".pt"
              hidden
              disabled={busy !== null}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void take(() => api.uploadWeights(file), "upload");
              }}
            />
          </label>
        </div>

        {error && <div className="mag-error">{error}</div>}

        {tab === "shelf" && (
          <div className="ag-list">
            {shelf === null && <p className="ag-muted">Загружаю…</p>}
            {shelf?.length === 0 && (
              <p className="ag-muted">Полка пуста. Загрузите .pt или возьмите веса из обучения.</p>
            )}
            {shelf?.map((w) => (
              <div key={w.id} className={`ag-row${w.id === current ? " on" : ""}`}>
                <div className="ag-row-main">
                  <b className="mono">{w.name}</b>
                  <span>
                    {w.task} <Sep /> {w.names.length} кл. <Sep />{" "}
                    {w.imgsz ?? "—"} <Sep /> {mb(w.size_bytes)}
                    {w.run && <> <Sep /> из «{w.run.name}»</>}
                  </span>
                </div>
                <button type="button" className="mag-ghost" onClick={() => remove(w)}>
                  Убрать
                </button>
                <button type="button" className="mag-btn" onClick={() => onPick(w)}>
                  Выбрать
                </button>
              </div>
            ))}
          </div>
        )}

        {tab === "runs" && (
          <div className="ag-list">
            {runs === null && <p className="ag-muted">Загружаю…</p>}
            {runs?.length === 0 && <p className="ag-muted">Готовых обучений в ваших проектах нет.</p>}
            {runs?.map((r) => (
              <div key={r.id} className="ag-row">
                <div className="ag-row-main">
                  <b>{r.name}</b>
                  <span>
                    {r.project} <Sep /> {r.base_model} <Sep />{" "}
                    {mb(r.weights_bytes)}
                  </span>
                </div>
                <button
                  type="button"
                  className="mag-btn"
                  disabled={busy !== null}
                  onClick={() => take(() => api.weightsFromRun(r.id), r.id)}
                >
                  {busy === r.id ? "Беру…" : "Взять"}
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="ag-foot">
          <button type="button" className="mag-ghost" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
