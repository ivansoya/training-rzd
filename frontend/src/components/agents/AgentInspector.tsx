// Шторка, левая колонка: параметры выбранного узла агента.
//
// Проверку формы делает сервер при сохранении версии (common/agent_graph.py). Пределы
// чисел — исключение: форма берёт их из той же таблицы (agentDoc.LIMITS) и не даёт за них
// выйти, а сохранённое до пределов значение подсвечивает.

import type { Node } from "@xyflow/react";
import { useState, type ReactNode } from "react";
import * as api from "../../api/agents";
import { Badge, Button, Empty, Field, Icon, Popover, Seg, Select, Switch } from "../../ui";
import { NumInput } from "../NumInput";
import {
  LIMITS, MAX_PASSES, SAM_DEFAULTS, SAM_MODELS, TEXT_IMGSZ, TEXT_MODELS, TILE_OVERLAP, TITLES, frameCalls, inputSide, mergeInputs,
  isExamples, offLimits, promptsOf, rowTarget, rowsOf, SAM3_WORDS, sam3DefaultWords, sam3Mb, sam3Side, sam3Words, switchTextModel,
  textConfDefault,
  textModel, tileSide, viewCount,
  type AgentClass, type FilterRow,
} from "./agentDoc";
import { agentTitle, type AgentNodeData } from "./AgentNodes";
import ClassCards from "./ClassCards";
import { ClassList, FilterClasses, NetClasses } from "./ClassTables";
import { gb } from "./GpuVerdict";
import { decimal, iconOf, roleOf, toneOf } from "./look";

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const mb = (bytes: number) => `${(bytes / (1 << 20)).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
const ru = (v: number, digits = 1) => v.toLocaleString("ru-RU", { maximumFractionDigits: digits });
const took = (ms: number) => (ms < 1000 ? `${Math.round(ms)} мс` : `${ru(ms / 1000)} с`);
const plural = (n: number, one: string, few: string, many: string) => {
  const t = n % 10, h = n % 100;
  return t === 1 && h !== 11 ? one : t >= 2 && t <= 4 && (h < 12 || h > 14) ? few : many;
};

const DETAIL = [
  { value: "auto", label: "Как решит модель" },
  { value: "object", label: "Объект целиком" },
  { value: "part", label: "Часть" },
  { value: "subpart", label: "Подчасть" },
];

const SIDES = [
  { value: "644", label: "644 · быстрее" },
  { value: "1008", label: "1008 · точнее" },
];

export default function AgentInspector({ node, readOnly, weights, sam3Ready, sets, goneSets, onSet, classes, ensure, ensureRef, projects,
  onClasses, incoming, loose, onChange, onPickWeights, onRemove, pinned, onPin, frame, previewImage, msPerCall, hits, expanded, onExpand,
  summary, est }: {
  node: Node | null;
  readOnly: boolean;
  weights?: api.Weights;
  sam3Ready: boolean | null;
  sets: Map<string, api.ExampleSet>;
  /** Наборы, которых больше нет на сервере. */
  goneSets: Set<string>;
  onSet: (set: api.ExampleSet) => void;
  /** Классы агента — для выбора в строках узлов. */
  classes: AgentClass[];
  /** Класс агента по имени: найденный или заведённый. */
  ensure: (name: string) => string | null;
  /** Класс-ссылка на класс проекта. */
  ensureRef: (project: api.ClassSource, cls: api.ClassSource["classes"][number]) => string | null;
  projects: api.ClassSource[] | null;
  /** Окно «Классы агента». */
  onClasses: () => void;
  /** Id классов агента, что приходят к узлу: «Фильтр» показывает только их. */
  incoming: string[];
  loose: boolean;
  onChange: (next: Record<string, unknown>) => void;
  onPickWeights: () => void;
  onRemove: () => void;
  pinned: boolean;
  onPin: () => void;
  /** Кадры проекта превью: на них считаются тайлы. */
  frame: api.FrameSummary | null;
  /** Кадр, что сейчас в превью: на нём коллаж в окне «Образцы класса». */
  previewImage: { id: string; width: number; height: number } | null;
  /** Замер последнего превью: мс на один вызов модели этого узла. */
  msPerCall?: number;
  /** Своих рамок узла на кадре превью по номеру строки; null — превью нет. */
  hits: Map<number, number> | null;
  /** Сводка агента — показывает узел «Выход». */
  summary?: ReactNode;
  /** Узел развёрнут на всё окно. */
  expanded: boolean;
  onExpand: () => void;
  /** Оценка памяти агента (сервер): память узла и порция «Авто» у SAM 3. */
  est?: api.Estimate | null;
}) {
  const [fine, setFine] = useState(false);
  if (!node) {
    return (
      <section className="ge-sec ae-insp">
        <Empty compact icon="pointer" title="Выберите узел на холсте">
          Здесь появятся его параметры. Новый узел — из полосы справа: щелчком или перетаскиванием, можно прямо на провод.
          Двойной щелчок по узлу разворачивает его на всё окно.
        </Empty>
      </section>
    );
  }
  const d = node.data as AgentNodeData;
  const p = d.params;
  const model = textModel(p);
  const sam3 = d.kind === "text" && model === "sam3";
  const sam3Missing = sam3 && sam3Ready === false;
  const fixed = d.kind === "frame" || d.kind === "output";
  const nodeMb = est?.nodes[node.id];
  const heaviest = Boolean(est?.heaviest?.nodes.includes(node.id) && (est?.units.length ?? 0) > 1);
  const words = d.kind === "text" ? promptsOf({ params: p }).filter((r) => r.on && !isExamples(r) && rowTarget(r) && r.cls).length : 0;
  const autoWords = est?.words[node.id] ?? sam3DefaultWords(p);
  // Цена порции: память агента целиком, если узел возьмёт её, и проходы описаний на вид кадра.
  const wordsOption = (per: number) => {
    const mb = sam3Mb(p, Math.min(per, words), est?.sam3_cpu_half ?? true);
    const total = est && nodeMb !== undefined ? est.estimate_mb - nodeMb + mb : mb;
    const passes = Math.max(1, Math.ceil(words / per));
    return `≈ ${gb(total)} ГБ · ${passes} ${plural(passes, "проход", "прохода", "проходов")}`;
  };
  const memoryRow = nodeMb !== undefined && (
    <div className="ae-panel-row">
      <span className="ae-panel-l">Память узла</span>
      <span className="ae-panel-v t-ell">
        <b className={heaviest ? "ae-heavy" : undefined} title={heaviest ? "Самый тяжёлый узел агента" : undefined}>≈ {gb(nodeMb)} ГБ</b>
        {sam3 ? ` · SAM 3 на входе ${sam3Side(p)}` : ""}
        {sam3 && words > 0 ? `, ${Math.min(autoWords, words)} ${plural(Math.min(autoWords, words), "слово", "слова", "слов")} за проход` : ""}
      </span>
    </div>
  );

  // Пустое необязательное поле — «без предела», поэтому null, а не умолчание.
  const number = (key: string, label: string, value: number | undefined, step: number, empty?: boolean, aside?: ReactNode): ReactNode => {
    const lim = LIMITS[d.kind]?.[key];
    const bad = offLimits(lim, p[key]);
    return (
      <Field key={key} label={label} aside={aside} error={bad && lim ? `от ${decimal(lim.lo)} до ${decimal(lim.hi)}` : undefined}>
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

  // Тайлинг и вызовы модели на кадр проекта превью — тем же счётом, что потолок на сервере.
  const netIn = d.kind === "net" ? weights?.imgsz : null;
  const side = tileSide(d.kind, p, netIn);
  const zoom = inputSide(d.kind, p, netIn) / side;
  const overlap = num(p.overlap, TILE_OVERLAP);
  const tiling = Boolean(p.tiles);
  const size = (set: string) => sets.get(set)?.items.length;
  const views = frame ? viewCount(p, frame.w, frame.h, side) : null;
  const total = views ? views.whole + views.tiles : 1;
  const calls = frame ? frameCalls(d.kind, p, frame.w, frame.h, side, size) : null;
  const big = frame && (frame.largest[0] !== frame.w || frame.largest[1] !== frame.h) ? frame.largest : null;
  const worst = big ? frameCalls(d.kind, p, big[0], big[1], side, size) : calls;
  const time = msPerCall !== undefined && calls !== null ? `≈ ${took(msPerCall * calls)}` : null;
  const ceiling = (
    <>
      {worst !== null && worst > MAX_PASSES && big && (
        <span className="bad">На самом большом кадре {big[0]}×{big[1]} — {worst} вызовов модели, больше {MAX_PASSES} нельзя</span>
      )}
      {calls !== null && calls > MAX_PASSES && (
        <span className="bad">Больше {MAX_PASSES} вызовов модели на кадр нельзя — увеличьте тайл{sam3 ? " или уберите образцы" : ""}</span>
      )}
    </>
  );
  const viewsText = views && views.tiles
    ? `${views.whole ? "1 целый + " : ""}${views.tiles} ${plural(views.tiles, "тайл", "тайла", "тайлов")}` : "кадр не больше тайла";
  const tileFields = (
    <div className="ae-tile-f">
      {number("tile", "Тайл, px", side, 32, false,
        Math.abs(zoom - 1) > 0.01 ? `${zoom > 1 ? "×" : "÷"}${ru(zoom > 1 ? zoom : 1 / zoom)} к объекту` : "1:1")}
      {number("overlap", "Перекрытие", overlap, 0.05, false, `${Math.round(side * overlap)} px`)}
      <div className="ae-wide">
        {flag("whole", "+ целый кадр", p.whole !== false, "Отдельный проход целым кадром: крупный объект тайл режет на обрывки")}
      </div>
    </div>
  );
  const fineFields = (
    <>
      <button type="button" className="ae-fold" aria-expanded={fine} onClick={() => setFine((v) => !v)}>
        <Icon name="chevD" size={14} />Тонкая настройка
      </button>
      {fine && <div className="ae-tile-f">{number("glue", "Склейка от, IoS", num(p.glue, 0.5), 0.05)}</div>}
    </>
  );
  // У «Сети» — блок с переключателем и итогом, как был.
  const netPasses = (
    <div className={tiling ? "ae-tile on" : "ae-tile"}>
      <div className="ae-tile-h">
        <b>Тайлинг</b>
        <span className="grow" />
        <Switch checked={tiling} label="Тайлинг" disabled={readOnly} onChange={(v) => onChange({ tiles: v })} />
      </div>
      {tiling && tileFields}
      <div className="ae-tile-sum">
        {!frame ? <span>Размер кадра появится, когда в проекте превью будут кадры</span> : (
          <>
            <span className="ui-mono">
              {frame.w}×{frame.h}
              {frame.share < 0.995 && <em> · у {Math.round((1 - frame.share) * 100)} % кадров другой размер</em>}
            </span>
            {tiling && views && <span>{viewsText} = {total} {plural(total, "проход", "прохода", "проходов")}</span>}
          </>
        )}
        <b>{time ? `${time} на кадр` : tiling ? "время — после превью" : "1 проход"}</b>
        {ceiling}
      </div>
      {tiling && fineFields}
    </div>
  );
  const contour = `до ${num(p.polygon_points, SAM_DEFAULTS.polygon_points)} точек · куски от ${num(p.min_area, SAM_DEFAULTS.min_area)} px²`
    + (p.fill_holes !== false ? " · дыры залиты" : "");

  return (
    <section className="ge-sec ae-insp">
      <ClassList classes={classes} />
      <div className="ge-sec-h">
        <span className="ge-tone" style={{ color: toneOf(d.kind) }}><Icon name={iconOf(d.kind)} /></span>
        <b className="t-ell">{fixed ? agentTitle(d) : TITLES[d.kind] ?? d.kind}</b>
        {/* Подпись правится прямо в шапке, как имя агента: отдельное поле только теснило параметры. */}
        {!fixed && (
          <input className="ae-label-in" value={String(p.label ?? "")} disabled={readOnly} maxLength={60}
            placeholder={readOnly ? "" : "+ подпись"} aria-label="Подпись узла" size={Math.max(10, String(p.label ?? "").length + 1)}
            title="Подпись различает два одинаковых узла на холсте и в ошибках"
            onChange={(e) => onChange({ label: e.target.value || undefined })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        )}
        <Badge tone={toneOf(d.kind)}>{roleOf(d.kind)}</Badge>
        <span className="grow" />
        <Button size="sm" icon={expanded ? "shrink" : "fit"} onClick={onExpand}
          title={expanded ? "Вернуть холст (Esc)" : "Узел на всё окно — или двойной щелчок по узлу на холсте"}>
          {expanded ? "Свернуть" : "Развернуть"}
        </Button>
        <Button size="sm" variant="ghost" icon="eye" className={pinned ? "ge-pin on" : "ge-pin"} aria-pressed={pinned}
          aria-label={pinned ? "Открепить превью" : "Закрепить в превью"} onClick={onPin} />
        {!readOnly && !fixed && <Button size="sm" variant="ghost" icon="trash" aria-label="Удалить узел (Delete)" onClick={onRemove} />}
      </div>
      {loose && !readOnly && (
        <p className="ge-loose"><Icon name="alert" size={14} />Не подключён: протяните провод от выхода другого узла или бросьте узел на провод</p>
      )}

      {d.kind === "frame" && <p className="t-xs t-muted">Кадр таски — с него начинается каждый проход агента. Параметров нет.</p>}
      {d.kind === "output" && (
        <>
          <p className="t-xs t-muted">Что придёт сюда, ляжет в разметку кадра рамками агента. Ниже — сводка агента целиком.</p>
          {summary}
        </>
      )}

      {d.kind === "text" && (
        <>
          <div className="ae-block">
            <section className="ae-panel">
              <div className="ae-panel-h">
                <b>Модель и поиск</b>
                <span className="ae-readout" title={calls !== null && frame ? `Вызовов модели на кадр ${frame.w}×${frame.h}` : undefined}>
                  {time ? <>{time} <em>на кадр</em></> : <em>время — после превью</em>}
                  {calls !== null && <em> · {calls} {plural(calls, "вызов", "вызова", "вызовов")}</em>}
                </span>
              </div>
              <div className="ae-panel-top">
                <Field label="Модель">
                  {() => (
                    <Seg size="sm" label="Модель" value={model} onChange={(m) => !readOnly && onChange(switchTextModel(p, m))}
                      options={TEXT_MODELS.map((m) => ({ value: m, label: m === "sam3" ? "SAM 3" : m, disabled: readOnly,
                        title: m === "sam3" ? "SAM 3 — рамка и контур" : `YOLOE-26 ${m} — только рамки` }))} />
                  )}
                </Field>
                {sam3 ? (
                  <Field label="Вход">
                    {() => (
                      <Seg size="sm" label="Вход SAM 3" value={String(sam3Side(p))} onChange={(v) => !readOnly && onChange({ side: Number(v) })}
                        options={SIDES.map((o) => ({ ...o, disabled: readOnly }))} />
                    )}
                  </Field>
                ) : number("imgsz", "Размер входа", num(p.imgsz, TEXT_IMGSZ), 32)}
                {number("conf", "Порог узла", num(p.conf, textConfDefault(model)), 0.05)}
                {/* У SAM 3 всегда: без описаний поле видно, но выключено — порцию нечем делить */}
                {sam3 && (
                  <Field label="Слов за проход" aside={words > 0 ? wordsOption(sam3Words(p) ?? autoWords) : undefined}
                    hint={words > 0 ? undefined : "Нет включённых описаний — делить нечего"}>
                    {(id) => (
                      <Select size="sm" id={id} label="Слов за проход" value={String(sam3Words(p) ?? "auto")} disabled={readOnly || words === 0}
                        onChange={(v) => onChange({ words: v === "auto" ? null : Number(v) })}
                        options={[
                          { value: "auto", label: `Авто · ${autoWords}`, hint: `${wordsOption(autoWords)} — самая крупная порция, что влезает в карту` },
                          ...SAM3_WORDS.map((w) => ({
                            value: String(w), label: String(w),
                            hint: `${wordsOption(w)}${w === 1 ? " — меньше всего памяти, дольше всего" : w === sam3DefaultWords(p) ? ` — умолчание для входа ${sam3Side(p)}` : w >= words ? ` — все ${words} разом` : ""}`,
                          })),
                        ]} />
                    )}
                  </Field>
                )}
              </div>
              {memoryRow}
              {sam3 && (
                <div className="ae-panel-row">
                  <span className="ae-panel-l">Контур</span>
                  <span className="ae-panel-v t-ell" title={contour}>{contour}</span>
                  <Popover align="end" width={280} trigger={<Button size="sm" variant="ghost" icon="sliders" disabled={readOnly}>Настроить</Button>}>
                    <div className="ae-contour">
                      {number("polygon_points", "Точек контура до", num(p.polygon_points, SAM_DEFAULTS.polygon_points), 8)}
                      {number("min_area", "Кусок от, px² кадра", num(p.min_area, SAM_DEFAULTS.min_area), 16)}
                      {flag("fill_holes", "Заливать дыры", p.fill_holes !== false)}
                    </div>
                  </Popover>
                </div>
              )}
              <div className="ae-panel-row">
                <span className="ae-panel-l">Тайлинг</span>
                <span className="ae-panel-v">
                  {tiling ? `${views ? viewsText : "тайлы"} · тайл ${side} px` : "выключен — кадр идёт целиком"}
                </span>
                <Switch checked={tiling} label="Тайлинг" disabled={readOnly} onChange={(v) => onChange({ tiles: v })} />
              </div>
              {tiling && <div className="ae-panel-sub">{tileFields}{fineFields}</div>}
            </section>
            {sam3Missing && (
              <div className="ae-w bad"><b>Нет весов SAM 3 на сервере</b><span>Нужен файл _autolabel/sam3/sam3.pt — без него версию не сохранить</span></div>
            )}
            {ceiling}
          </div>
          <ClassCards rows={promptsOf({ params: p })} readOnly={readOnly} classes={classes} ensure={ensure} ensureRef={ensureRef}
            projects={projects} nodeConf={num(p.conf, textConfDefault(model))} model={model} sets={sets} gone={goneSets} onSet={onSet}
            onRows={(rows) => onChange({ prompts: rows })} hits={hits}
            view={frame ? (tiling ? [Math.min(frame.w, side), Math.min(frame.h, side)] : [frame.w, frame.h]) : null}
            views={total} msPerCall={msPerCall} onClasses={onClasses}
            preview={{ image: previewImage, side: sam3Side(p), tile: tiling ? side : null }} />
        </>
      )}

      {!fixed && d.kind !== "text" && (
        <div className="ge-params">
          {nodeMb !== undefined && (d.kind === "net" || d.kind === "sam") && (
            <div className="ae-w">
              <b>Память узла <span className={heaviest ? "ae-heavy" : undefined} title={heaviest ? "Самый тяжёлый узел агента" : undefined}>≈ {gb(nodeMb)} ГБ</span></b>
              <span>{d.kind === "sam" ? "все модели уточнения грузятся вместе" : "прикидка, по замеру диспетчер поправит"}</span>
            </div>
          )}
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
              {netPasses}
              {weights && (
                <div className="ae-wide">
                  <NetClasses names={weights.names} rows={rowsOf({ params: p })} readOnly={readOnly} classes={classes} ensure={ensure}
                    onRows={(rows) => onChange({ classes: rows })} />
                </div>
              )}
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
                <FilterClasses ids={incoming} rows={(p.classes as FilterRow[] | undefined) ?? []} readOnly={readOnly} classes={classes}
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
