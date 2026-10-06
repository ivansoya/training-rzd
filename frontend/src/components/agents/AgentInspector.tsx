// Шторка, первая колонка: параметры выбранного узла агента.
//
// Проверку формы делает сервер при сохранении версии (common/agent_graph.py). Пределы
// чисел — исключение: форма берёт их из той же таблицы (agentDoc.LIMITS) и не даёт за них
// выйти, а сохранённое до пределов значение подсвечивает.

import type { Node } from "@xyflow/react";
import type { ReactNode } from "react";
import * as api from "../../api/agents";
import { Badge, Button, Empty, Field, Icon, Input, Seg, Select, Switch } from "../../ui";
import { NumInput } from "../NumInput";
import {
  LIMITS, SAM_DEFAULTS, SAM_MODELS, TEXT_IMGSZ, TEXT_MODELS, YOLOE_MB, mergeInputs, offLimits, promptsOf, rowsOf,
  switchTextModel, textConfDefault, textModel, type FilterRow,
} from "./agentDoc";
import { agentTitle, type AgentNodeData } from "./AgentNodes";
import { FilterClasses, NetClasses, PromptTable } from "./ClassTables";
import { decimal, iconOf, roleOf, toneOf } from "./look";

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const mb = (bytes: number) => `${(bytes / (1 << 20)).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;

const DETAIL = [
  { value: "auto", label: "Как решит модель" },
  { value: "object", label: "Объект целиком" },
  { value: "part", label: "Часть" },
  { value: "subpart", label: "Подчасть" },
];

export default function AgentInspector({ node, readOnly, weights, sam3Ready, sets, onSet, colorOf, incoming, loose,
  onChange, onPickWeights, onRemove, pinned, onPin }: {
  node: Node | null;
  readOnly: boolean;
  weights?: api.Weights;
  sam3Ready: boolean | null;
  sets: Map<string, api.ExampleSet>;
  onSet: (set: api.ExampleSet) => void;
  colorOf: Map<string, { color: string; sources: unknown[] }>;
  /** Классы агента, что приходят к узлу: «Фильтр» показывает только их. */
  incoming: string[];
  loose: boolean;
  onChange: (next: Record<string, unknown>) => void;
  onPickWeights: () => void;
  onRemove: () => void;
  pinned: boolean;
  onPin: () => void;
}) {
  if (!node) {
    return (
      <section className="ge-sec ae-insp">
        <Empty compact icon="pointer" title="Выберите узел на холсте">
          Здесь появятся его параметры. Новый узел — из колонки справа: щелчком или перетаскиванием, можно прямо на провод.
        </Empty>
      </section>
    );
  }
  const d = node.data as AgentNodeData;
  const p = d.params;
  const model = textModel(p);
  const sam3Missing = d.kind === "text" && model === "sam3" && sam3Ready === false;
  const fixed = d.kind === "frame" || d.kind === "output";

  // Пустое необязательное поле — «без предела», поэтому null, а не умолчание.
  const number = (key: string, label: string, value: number | undefined, step: number, empty?: boolean): ReactNode => {
    const lim = LIMITS[d.kind]?.[key];
    const bad = offLimits(lim, p[key]);
    return (
      <Field key={key} label={label} error={bad && lim ? `от ${decimal(lim.lo)} до ${decimal(lim.hi)}` : undefined}>
        {(id) => (
          <NumInput id={id} className="ui-input ui-ctl ui-mono" value={value} min={lim?.lo} max={lim?.hi} step={step} integer={lim?.int}
            allowEmpty={empty} placeholder={empty ? "без предела" : undefined} disabled={readOnly} aria-invalid={bad || undefined}
            onValue={(v) => onChange({ [key]: v ?? null })} />
        )}
      </Field>
    );
  };
  const flag = (key: string, label: string, on: boolean, hint?: string) => (
    <div key={key} className="ge-flag" title={hint}>
      <span>{label}</span>
      <Switch checked={on} label={label} disabled={readOnly} onChange={(v) => onChange({ [key]: v })} />
    </div>
  );
  const passes = (
    <>
      {flag("tiles", "Плитки и целый кадр", Boolean(p.tiles), "Кадр режется на плитки размером со вход сети, плюс проход целым кадром")}
      {flag("tta_flip", "TTA: отражение", Boolean(p.tta_flip))}
      {flag("tta_scales", "TTA: масштабы ×0,8 и ×1,25", Boolean(p.tta_scales))}
      {Boolean(p.tiles) && number("overlap", "Перекрытие плиток", num(p.overlap, 0.2), 0.05)}
      {Boolean(p.tiles) && number("glue", "Склейка от, IoS", num(p.glue, 0.5), 0.05)}
    </>
  );

  return (
    <section className="ge-sec ae-insp">
      <div className="ge-sec-h">
        <span className="ge-tone" style={{ color: toneOf(d.kind) }}><Icon name={iconOf(d.kind)} /></span>
        <b className="t-ell">{agentTitle(d)}</b>
        <Badge tone={toneOf(d.kind)}>{roleOf(d.kind)}</Badge>
        <span className="grow" />
        <Button size="sm" variant="ghost" icon="eye" className={pinned ? "ge-pin on" : "ge-pin"} aria-pressed={pinned}
          aria-label={pinned ? "Открепить превью" : "Закрепить в превью"} onClick={onPin} />
        {!readOnly && !fixed && <Button size="sm" variant="ghost" icon="trash" aria-label="Удалить узел (Delete)" onClick={onRemove} />}
      </div>
      {loose && !readOnly && (
        <p className="ge-loose"><Icon name="alert" size={14} />Не подключён: протяните провод от выхода другого узла или бросьте узел на провод</p>
      )}

      {d.kind === "frame" && <p className="t-xs t-muted">Кадр таски — с него начинается каждый проход агента. Параметров нет.</p>}
      {d.kind === "output" && <p className="t-xs t-muted">Что придёт сюда, ляжет в разметку кадра рамками агента. Параметров нет.</p>}

      {!fixed && (
        <div className="ge-params">
          <Field label="Подпись" hint="Различает два одинаковых узла на холсте и в ошибках">
            {(id) => <Input id={id} value={String(p.label ?? "")} disabled={readOnly} maxLength={60}
              onChange={(e) => onChange({ label: e.target.value || undefined })} />}
          </Field>

          {d.kind === "net" && (
            <>
              <div className="ae-w">
                {weights ? (
                  <>
                    <b className="ui-mono t-ell" title={weights.name}>{weights.name}</b>
                    <span>{weights.task} · вход {weights.imgsz ?? "—"} · {weights.names.length} кл. · {mb(weights.size_bytes)}</span>
                    {weights.run && <span>из обучения «{weights.run.name}»</span>}
                  </>
                ) : <b className="ge-warn">Веса не выбраны</b>}
                {!readOnly && <Button size="sm" icon="database" onClick={onPickWeights}>{weights ? "Сменить веса" : "Выбрать веса"}</Button>}
              </div>
              {/* IoU здесь нет: у yolo26 NMS нет вовсе, у yolo11 и v8 он встроен — гасить дубли узлом «NMS». */}
              {number("conf", "Уверенность от", num(p.conf, 0.25), 0.05)}
              {number("imgsz", "Размер входа", num(p.imgsz, weights?.imgsz ?? 640), 32)}
              {passes}
              {weights && (
                <div className="ae-wide">
                  <NetClasses names={weights.names} rows={rowsOf({ params: p })} readOnly={readOnly} colorOf={colorOf}
                    onRows={(rows) => onChange({ classes: rows })} />
                </div>
              )}
            </>
          )}

          {d.kind === "text" && (
            <>
              <Field label="Модель" hint={model === "sam3" ? "SAM 3 — рамка и контур" : "YOLOE-26 — только рамки"}>
                {() => (
                  <Seg size="sm" label="Модель" value={model} onChange={(m) => !readOnly && onChange(switchTextModel(p, m))}
                    options={TEXT_MODELS.map((m) => ({ value: m, label: m === "sam3" ? "SAM 3" : m, disabled: readOnly }))} />
                )}
              </Field>
              <div className={sam3Missing ? "ae-w bad" : "ae-w"}>
                {model !== "sam3" ? (
                  <><b className="ui-mono">yoloe-26{model}-seg.pt</b><span>{YOLOE_MB[model]} МБ · в образе · только рамки</span></>
                ) : sam3Missing ? (
                  <><b>Нет весов SAM 3 на сервере</b><span>Нужен файл _autolabel/sam3/sam3.pt — без него версию не сохранить</span></>
                ) : (
                  <><b className="ui-mono">sam3.pt</b><span>3,45 ГБ · на сервере · рамка и контур</span></>
                )}
              </div>
              {number("conf", "Порог узла", num(p.conf, textConfDefault(model)), 0.05)}
              {model === "sam3" ? (
                <>
                  {number("polygon_points", "Точек контура до", num(p.polygon_points, SAM_DEFAULTS.polygon_points), 8)}
                  {number("min_area", "Кусок от, px²", num(p.min_area, SAM_DEFAULTS.min_area), 16)}
                  {flag("fill_holes", "Заливать дыры", p.fill_holes !== false)}
                </>
              ) : (
                <>
                  {number("imgsz", "Размер входа", num(p.imgsz, TEXT_IMGSZ), 32)}
                  {passes}
                </>
              )}
              <div className="ae-wide">
                <PromptTable rows={promptsOf({ params: p })} readOnly={readOnly} colorOf={colorOf} nodeConf={num(p.conf, textConfDefault(model))}
                  model={model} sets={sets} onSet={onSet} onRows={(rows) => onChange({ prompts: rows })} />
              </div>
            </>
          )}

          {d.kind === "merge" && number("inputs", "Входов", mergeInputs(p), 1)}

          {d.kind === "nms" && (
            <>
              {number("iou", "IoU от", num(p.iou, 0.6), 0.05)}
              {flag("agnostic", "Между классами", Boolean(p.agnostic), "Гасить перекрытия рамок разных классов")}
            </>
          )}

          {d.kind === "filter" && (
            <>
              {number("min_side", "Сторона от, px", typeof p.min_side === "number" ? p.min_side : undefined, 1, true)}
              {number("max_side", "Сторона до, px", typeof p.max_side === "number" ? p.max_side : undefined, 1, true)}
              <div className="ae-wide">
                <FilterClasses names={incoming} rows={(p.classes as FilterRow[] | undefined) ?? []} readOnly={readOnly} colorOf={colorOf}
                  onRows={(rows) => onChange({ classes: rows })} />
              </div>
            </>
          )}

          {d.kind === "sam" && (
            <>
              <Field label="Модель">
                {(id) => <Select id={id} full value={String(p.model ?? SAM_DEFAULTS.model)} disabled={readOnly} label="Модель"
                  onChange={(v) => onChange({ model: v })} options={SAM_MODELS.map(([value, label]) => ({ value, label }))} />}
              </Field>
              <Field label="Детализация">
                {(id) => <Select id={id} full value={String(p.detail ?? SAM_DEFAULTS.detail)} disabled={readOnly} label="Детализация"
                  onChange={(v) => onChange({ detail: v })} options={DETAIL} />}
              </Field>
              {number("score_min", "Порог маски", num(p.score_min, SAM_DEFAULTS.score_min), 0.05)}
              {number("min_area", "Кусок от, px²", num(p.min_area, SAM_DEFAULTS.min_area), 16)}
              {number("polygon_points", "Точек контура до", num(p.polygon_points, SAM_DEFAULTS.polygon_points), 8)}
              {flag("fill_holes", "Заливать дыры", p.fill_holes !== false)}
            </>
          )}
        </div>
      )}
    </section>
  );
}
