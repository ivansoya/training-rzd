// Настройки полуавтомата SAM2 — во всплывашке у кнопки A.

import type { AutoRefine } from "../../auth/api";
import { Field, Input, Range, Seg, Select, Switch } from "../../ui";

const DETAIL = [
  { value: "auto", label: "Как решит модель" },
  { value: "object", label: "Объект целиком" },
  { value: "part", label: "Часть" },
  { value: "subpart", label: "Подчасть" },
] as const;

export default function AutoSettings({ refine, onRefine, mode, onMode, polygon, afterSelect, onAfterSelect, error }: {
  refine: AutoRefine;
  onRefine: (next: AutoRefine) => void;
  /** Вид ввода; без него — только точки. */
  mode?: "points" | "box";
  onMode?: (m: "points" | "box") => void;
  /** Контурный инструмент: число точек влияет только на контур. */
  polygon: boolean;
  afterSelect?: boolean;
  onAfterSelect?: (v: boolean) => void;
  error?: string | null;
}) {
  const set = (patch: Partial<AutoRefine>) => onRefine({ ...refine, ...patch });
  const score = refine.score_min ?? 0;
  return (
    <div className="ed-set-b">
      <div className="ui-pop-h">Полуавтомат SAM2</div>
      {mode && onMode && (
        <Seg label="Вид ввода" value={mode} onChange={onMode} size="sm"
          options={[{ value: "points", label: "Точки" }, { value: "box", label: "Область" }]} />
      )}
      <Field label="Детализация">
        {(id) => (
          <Select id={id} full size="sm" value={refine.detail ?? "auto"} options={[...DETAIL]}
            onChange={(v) => set({ detail: v as AutoRefine["detail"] })} />
        )}
      </Field>
      <Field label="Порог" aside={<span className="ui-mono">{score.toFixed(2)}</span>}>
        {(id) => (
          <Range id={id} min={0} max={0.9} step={0.05} value={score}
            onChange={(e) => set({ score_min: Number(e.target.value) })} />
        )}
      </Field>
      <Field label="Мелочь, px²" hint="Куски маски меньше этого отбрасываются">
        {(id) => (
          <Input id={id} type="number" min={0} step={16} value={refine.min_area ?? 0}
            onChange={(e) => set({ min_area: Number(e.target.value) })} />
        )}
      </Field>
      {polygon && (
        <Field label="Точек в контуре" aside={<span className="ui-mono">{refine.polygon_points ?? 64}</span>}>
          {(id) => (
            <Range id={id} min={8} max={200} step={4} value={refine.polygon_points ?? 64}
              onChange={(e) => set({ polygon_points: Number(e.target.value) })} />
          )}
        </Field>
      )}
      <label className="ed-set-row">
        <span>Закрывать дыры в объекте</span>
        <Switch label="Закрывать дыры в объекте" checked={!!refine.fill_holes} onChange={(v) => set({ fill_holes: v })} />
      </label>
      {onAfterSelect && (
        <label className="ed-set-row">
          <span>После закрепления — в выбор</span>
          <Switch label="После закрепления выходить в выбор" checked={!!afterSelect} onChange={onAfterSelect} />
        </label>
      )}
      <p className="ed-set-hint">
        {mode === "box"
          ? "Обведите объект — модель уточнит границы. Пробел, щелчок или новая рамка — закрепить."
          : "Щелчок — объект под курсором. Shift+щелчок уточняет, Shift+правая убирает участок, Shift по рамке доуточняет её. Пробел или щелчок мимо — закрепить."}
      </p>
      {error && <p className="ed-set-err">{error}</p>}
    </div>
  );
}
