// Полка весов: выбрать для узла «Сеть», загрузить свой .pt, взять из обучения.
//
// Файл с чужим кодом внутри сервер отвергает до того, как его откроет torch
// (training_svc/pt_guard.py) — его ответ показывается как есть.

import { useEffect, useRef, useState } from "react";
import * as api from "../../api/agents";
import { Button, Dialog, Empty, Notice, Seg, Table, cx } from "../../ui";
import { useConfirm } from "../mag/tasks/Confirm";

const mb = (bytes: number | null | undefined) =>
  bytes ? `${(bytes / (1 << 20)).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ` : "—";

export default function WeightsPicker({ current, onPick, onClose }: {
  current?: string | null;
  onPick: (w: api.Weights) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"shelf" | "runs">("shelf");
  const [shelf, setShelf] = useState<api.Weights[] | null>(null);
  const [runs, setRuns] = useState<api.TrainedRun[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [confirm, confirmNode] = useConfirm();

  const load = () => api.listWeights().then((r) => setShelf(r.weights)).catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (tab === "runs" && runs === null) api.trainedRuns().then((r) => setRuns(r.runs)).catch((e) => setError(e.message));
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
    const ok = await confirm({ title: `Убрать «${w.name}» с полки?`, icon: "trash", danger: true, ok: "Убрать",
      desc: "Версии агентов, что на них ссылаются, перестанут запускаться." });
    if (!ok) return;
    setError(null);
    try {
      await api.deleteWeights(w.id);
      void load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} width={760} height={600} title="Веса для сети"
      desc="Свои .pt на полке, загрузка с диска или веса законченного обучения"
      above={
        <div className="ae-wp-bar">
          <Seg label="Откуда веса" value={tab} onChange={setTab} options={[
            { value: "shelf", label: <>Моя полка{shelf ? <span className="ui-mono t-faint"> {shelf.length}</span> : null}</> },
            { value: "runs", label: "Из обучений" },
          ]} />
          <span className="grow" />
          <Button icon="upload" disabled={busy !== null} onClick={() => file.current?.click()}>{busy === "upload" ? "Загружаю…" : "Загрузить .pt"}</Button>
          <input ref={file} type="file" accept=".pt" hidden onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void take(() => api.uploadWeights(f), "upload");
          }} />
        </div>
      }
      footer={<Button variant="ghost" onClick={onClose}>Закрыть</Button>}>
      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}

      {tab === "shelf" && (shelf === null ? <p className="t-sm t-muted">Загружаю…</p>
        : shelf.length === 0 ? <Empty compact icon="database" title="Полка пуста">Загрузите .pt или возьмите веса из обучения.</Empty> : (
          <Table className="ae-wp">
            <thead><tr><th>Файл</th><th>Задача</th><th className="r">Классов</th><th className="r">Вход</th><th className="r">Размер</th><th /></tr></thead>
            <tbody>
              {shelf.map((w) => (
                <tr key={w.id} className={cx(w.id === current && "on")}>
                  <td>
                    <b className="ui-mono">{w.name}</b>
                    {w.run && <p className="t-xs t-muted">из обучения «{w.run.name}»</p>}
                  </td>
                  <td>{w.task}</td>
                  <td className="r ui-mono">{w.names.length}</td>
                  <td className="r ui-mono">{w.imgsz ?? "—"}</td>
                  <td className="r ui-mono">{mb(w.size_bytes)}</td>
                  <td className="r ae-wp-act">
                    <Button size="sm" variant="ghost" icon="trash" aria-label={`Убрать ${w.name} с полки`} onClick={() => void remove(w)} />
                    <Button size="sm" variant={w.id === current ? "outline" : "primary"} onClick={() => onPick(w)}>
                      {w.id === current ? "Выбраны" : "Выбрать"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ))}

      {tab === "runs" && (runs === null ? <p className="t-sm t-muted">Загружаю…</p>
        : runs.length === 0 ? <Empty compact icon="activity" title="Готовых обучений нет">В ваших проектах ещё нет законченных обучений с весами.</Empty> : (
          <Table className="ae-wp">
            <thead><tr><th>Обучение</th><th>Проект</th><th>Модель</th><th className="r">Размер</th><th /></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.name}</b></td>
                  <td>{r.project}</td>
                  <td className="ui-mono">{r.base_model}</td>
                  <td className="r ui-mono">{mb(r.weights_bytes)}</td>
                  <td className="r ae-wp-act">
                    <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => take(() => api.weightsFromRun(r.id), r.id)}>
                      {busy === r.id ? "Беру…" : "Взять"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ))}
      {confirmNode}
    </Dialog>
  );
}
