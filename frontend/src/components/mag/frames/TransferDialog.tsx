import { useEffect, useState } from "react";
import { datasetUsage, mergeDatasets, moveDatasetImages } from "../../../api/datasets";
import type { DatasetUsage } from "../../../api/datasets";
import { Button, Dialog, Field, Notice, Pill, Select } from "../../../ui";
import { count, plural } from "../../ru";

export function TransferDialog({ code, source, datasets, ids, onClose, onDone }: {
  code: string;
  source: { id: string; name: string };
  datasets: { id: string; name: string }[];
  /** null — весь датасет; иначе выбранные кадры. */
  ids: string[] | null;
  onClose: () => void;
  onDone: (moved: number, target: string) => void | Promise<void>;
}) {
  const merge = ids === null;
  const [target, setTarget] = useState<string | undefined>();
  const [usage, setUsage] = useState<DatasetUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = datasets.filter((d) => d.id !== source.id).map((d) => ({ value: d.id, label: d.name }));
  useEffect(() => {
    if (!merge) return;
    let alive = true;
    datasetUsage(code, source.id).then((u) => { if (alive) setUsage(u); })
      .catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [code, source.id, merge]);

  const held = !!usage && (usage.tasks.length > 0 || usage.unbuilt_sets.length > 0);
  const act = async () => {
    if (!target || busy || (merge && (!usage || held))) return;
    setBusy(true);
    setError(null);
    try {
      const result = merge ? await mergeDatasets(code, source.id, target)
        : await moveDatasetImages(code, source.id, target, ids);
      await onDone(result.moved, target);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const amount = merge ? usage?.images : ids.length;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}
      title={merge ? "Слить датасеты" : "Перенести кадры"} width={460}
      desc={merge ? `Все кадры из «${source.name}» перейдут в выбранный датасет. Исходный датасет будет удалён.`
        : `${count(amount ?? 0, "кадр", "кадра", "кадров")} из «${source.name}» ${plural(amount ?? 0, "перейдёт", "перейдут", "перейдут")} в выбранный датасет вместе с разметкой.`}
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={onClose}>Отмена</Button>
        <Button variant="primary" disabled={!target || busy || (merge && (!usage || held))} onClick={() => void act()}>
          {busy ? "Переносим…" : merge ? "Слить датасеты" : "Перенести кадры"}
        </Button>
      </>}>
      <Field label="Датасет назначения">
        {(id) => <Select id={id} label="Датасет назначения" full value={target} onChange={setTarget}
          placeholder={options.length ? "Выберите датасет" : "Других датасетов нет"} options={options} disabled={!options.length || busy} />}
      </Field>
      {merge && usage && <p className="t-sm t-muted">К переносу: {count(usage.images, "кадр", "кадра", "кадров")} с разметкой и тегами.</p>}
      {usage && usage.tasks.length > 0 && <Pill tone="bad">Датасет держат незакрытые таски: {usage.tasks.map((t) => t.name).join(", ")}. Закройте их.</Pill>}
      {usage && usage.unbuilt_sets.length > 0 && <Pill tone="warn">Датасет выбран в несобранных наборах: {usage.unbuilt_sets.join(", ")}. Измените их отбор.</Pill>}
      {error && <Notice tone="error">{error}</Notice>}
    </Dialog>
  );
}
