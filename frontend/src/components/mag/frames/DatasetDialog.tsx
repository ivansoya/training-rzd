import { useEffect, useState } from "react";
import { datasetUsage, deleteDataset, renameDataset } from "../../../api/datasets";
import type { DatasetUsage } from "../../../api/datasets";
import { Button, Dialog, Field, Input, Meta, Notice, Pill } from "../../../ui";
import { count, ru } from "../../ru";

/** Имя датасета — у редактора, удаление — у админа: оно уносит кадры с разметкой и необратимо.
 *  Перед удалением окно спрашивает цену у сервера; держащие таски называет и удалить не даёт. */
export default function DatasetDialog({ code, dataset, mode, onClose, onDone }: {
  code: string;
  dataset: { id: string; name: string };
  mode: "rename" | "delete";
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [name, setName] = useState(dataset.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<DatasetUsage | null>(null);

  useEffect(() => {
    if (mode !== "delete") return;
    let alive = true;
    datasetUsage(code, dataset.id)
      .then((u) => alive && setUsage(u))
      .catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [code, dataset.id, mode]);

  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const fresh = name.trim();
  const canSave = !busy && fresh !== "" && fresh !== dataset.name;
  const held = usage !== null && usage.tasks.length > 0;

  if (mode === "rename") {
    return (
      <Dialog open onOpenChange={(v) => !v && onClose()} title="Переименовать датасет" width={440}
        footer={<>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" disabled={!canSave} onClick={() => act(() => renameDataset(code, dataset.id, fresh))}>
            Сохранить
          </Button>
        </>}>
        <Field label="Название" error={error}>
          {(id) => (
            <Input id={id} value={name} maxLength={255} autoFocus onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && canSave) void act(() => renameDataset(code, dataset.id, fresh)); }} />
          )}
        </Field>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={`Удалить датасет «${dataset.name}»`} width={460}
      desc="Кадры уйдут вместе с разметкой. Отменить удаление нельзя."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="danger" disabled={busy || usage === null || held}
          onClick={() => act(() => deleteDataset(code, dataset.id))}>
          {usage ? `Удалить ${count(usage.images, "кадр", "кадра", "кадров")}` : "Удалить"}
        </Button>
      </>}>
      {usage === null ? (
        error ? <Notice tone="error">{error}</Notice> : <p className="t-sm t-muted">Считаем, что уйдёт вместе с датасетом…</p>
      ) : (
        <>
          <Meta items={[["Кадров", ru(usage.images)], ["Разметок на них", ru(usage.annotations)]]} />
          {held && (
            <Pill tone="bad">
              Датасет держат незакрытые таски: {usage.tasks.map((t) => t.name).join(", ")}. Закройте их, чтобы удалить.
            </Pill>
          )}
          {usage.unbuilt_sets.length > 0 && (
            <Pill tone="warn">Его выбрали несобранные наборы: {usage.unbuilt_sets.join(", ")}.</Pill>
          )}
          {error && <Notice tone="error">{error}</Notice>}
        </>
      )}
    </Dialog>
  );
}
