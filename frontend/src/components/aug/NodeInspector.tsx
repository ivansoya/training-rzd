// Шторка, первая колонка: выбранный узел и его параметры по схеме реестра.
//
// Пределы приходят с сервера и уже приведены к установленной версии
// библиотеки: ползунок ходит по настоящей шкале. Ввести значение вне пределов
// нельзя — сервер его всё равно загнёт обратно.

import type { Node } from "@xyflow/react";
import type { Catalogue, ParamSpec } from "../../api/aug";
import { Badge, Button, Empty, Field, Icon, Input, Range, Select, Switch } from "../../ui";
import type { Counts } from "./counts";
import { MAX_BRANCHES, MAX_INPUTS, MAX_TIMES, branches, grid, inputsCount, times, weights } from "./counts";
import { titleOf, type NodeData } from "./GraphNodes";
import { argText, kindOf, num, toneOf } from "./look";
import { ru } from "../ru";

function NumberField({ spec, value, onChange, disabled }: {
  spec: ParamSpec; value: number; onChange: (v: number) => void; disabled?: boolean;
}) {
  return (
    <Field label={spec.label} hint={spec.hint ?? undefined} aside={<span className="ui-mono">{num(value, spec.int)}</span>}>
      {(id) => (
        <Range id={id} min={spec.low ?? 0} max={spec.high ?? 1} step={spec.step ?? (spec.int ? 1 : 0.01)} value={value}
          disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
      )}
    </Field>
  );
}

function RangeField({ spec, value, onChange, disabled }: {
  spec: ParamSpec; value: [number, number]; onChange: (v: [number, number]) => void; disabled?: boolean;
}) {
  const [a, b] = value;
  const props = { min: spec.low ?? 0, max: spec.high ?? 1, step: spec.step ?? (spec.int ? 1 : 0.01), disabled };
  return (
    <Field label={spec.label} hint={spec.hint ?? undefined} aside={<span className="ui-mono">{argText(spec, value)}</span>}>
      {(id) => (
        <div className="ge-pair">
          <Range id={id} {...props} value={a} aria-label={`${spec.label}, от`}
            onChange={(e) => onChange([Math.min(Number(e.target.value), b), b])} />
          <Range {...props} value={b} aria-label={`${spec.label}, до`}
            onChange={(e) => onChange([a, Math.max(Number(e.target.value), a)])} />
        </div>
      )}
    </Field>
  );
}

function ParamField({ spec, value, onChange, disabled }: {
  spec: ParamSpec; value: unknown; onChange: (v: unknown) => void; disabled?: boolean;
}) {
  if (spec.kind === "range") return <RangeField spec={spec} value={value as [number, number]} onChange={onChange} disabled={disabled} />;
  if (spec.kind === "number") return <NumberField spec={spec} value={Number(value)} onChange={onChange} disabled={disabled} />;
  if (spec.kind === "flag") {
    return (
      <div className="ge-flag">
        <span>{spec.label}</span>
        <Switch checked={Boolean(value)} onChange={onChange} label={spec.label} disabled={disabled} />
      </div>
    );
  }
  if (spec.kind === "choice" && spec.options?.length) {
    return (
      <Field label={spec.label} hint={spec.hint ?? undefined}>
        {(id) => (
          <Select id={id} full value={String(value)} disabled={disabled} label={spec.label} onChange={onChange}
            options={spec.options!.map((o) => ({ value: o, label: o }))} />
        )}
      </Field>
    );
  }
  return null;
}

const whole = (key: string, label: string, low: number, high: number, step = 1): ParamSpec =>
  ({ key, label, kind: "number", low, high, step, int: true, default: low });

/** Сколько образцов приходит в узел и сколько выходит — по числам на проводах. */
function through(totals: Counts | null, id: string): [number, number] | null {
  if (!totals) return null;
  let into = 0;
  let out = 0;
  for (const [k, v] of Object.entries(totals.edges)) {
    if (k.startsWith(`${id}:`)) out += v;
    if (k.split("->")[1]?.startsWith(`${id}:`)) into += v;
  }
  return [into, out];
}

export default function NodeInspector({ node, catalogue, readOnly, totals, loose, onChange, onRemove, pinned, onPin }: {
  node: Node | null;
  catalogue: Catalogue | null;
  readOnly?: boolean;
  totals: Counts | null;
  loose?: boolean;
  onChange: (next: Record<string, unknown>) => void;
  onRemove: () => void;
  /** Узел закреплён в превью. */
  pinned: boolean;
  onPin: () => void;
}) {
  if (!node) {
    return (
      <section className="ge-sec">
        <Empty compact icon="pointer" title="Выберите узел на холсте">
          Здесь появятся его параметры. Новый узел — из колонки справа: щелчком или перетаскиванием, можно прямо на провод.
        </Empty>
      </section>
    );
  }

  const data = node.data as NodeData;
  const params = data.params ?? {};
  const cat = (catalogue?.nodes ?? []).find((n) => n.op === params.op);
  const asNode = { id: node.id, type: data.kind, params } as const;
  const kind = kindOf(data.kind, cat);
  const flow = through(totals, node.id);
  const flowText = !flow ? "" : data.kind === "source" ? `выходит ${ru(flow[1])}`
    : data.kind === "output" ? `приходит ${ru(flow[0])}`
    : `${ru(flow[0])} на входе → ${ru(flow[1])} на выходе`;

  const setArg = (key: string, value: unknown) => onChange({ args: { ...((params.args as object) ?? {}), [key]: value } });

  return (
    <section className="ge-sec">
      <div className="ge-sec-h">
        <span className="ge-tone" style={{ color: toneOf(data.kind, cat?.group) }}><Icon name={kind.icon} /></span>
        <b className="t-ell">{titleOf({ ...data, catalogue: cat ?? data.catalogue })}</b>
        <Badge tone={toneOf(data.kind, cat?.group)}>{kind.label}</Badge>
        <span className="grow" />
        <Button size="sm" variant="ghost" icon="eye" className={pinned ? "ge-pin on" : "ge-pin"} aria-pressed={pinned}
          aria-label={pinned ? "Открепить превью" : "Закрепить в превью"} onClick={onPin} />
        {!readOnly && <Button size="sm" variant="ghost" icon="trash" aria-label="Удалить узел (Delete)" onClick={onRemove} />}
      </div>
      {loose && !readOnly
        ? <p className="ge-loose"><Icon name="alert" size={14} />Не подключён: протяните провод от выхода другого узла или бросьте узел на провод</p>
        : flowText && <p className="t-xs t-muted">{flowText}</p>}
      {cat?.why && <p className="t-xs t-faint ge-why">{cat.why}</p>}

      <div className="ge-params">
        {data.kind === "aug" && cat && (
          <>
            {cat.params.map((spec) => (
              <ParamField key={spec.key} spec={spec} disabled={readOnly}
                value={((params.args as Record<string, unknown>) ?? {})[spec.key] ?? spec.default}
                onChange={(v) => setArg(spec.key, v)} />
            ))}
            <NumberField spec={{ ...cat.chance, key: "chance", label: "Как часто" }} value={Number(params.chance ?? 1)}
              disabled={readOnly} onChange={(v) => onChange({ chance: v })} />
          </>
        )}

        {(data.kind === "source" || data.kind === "input" || data.kind === "output" || data.kind === "flow") && (
          <Field label="Подпись" hint={data.kind === "source" ? "По ней источник выбирают при сборке набора" : undefined}>
            {(id) => (
              <Input id={id} value={(params.name as string) ?? (params.label as string) ?? ""} disabled={readOnly}
                // У «Входа», «Выхода» и «Источника» подпись — ещё и имя гнезда: сервер читает name, холст — label.
                onChange={(e) => onChange(data.kind === "flow" ? { label: e.target.value } : { name: e.target.value, label: e.target.value })} />
            )}
          </Field>
        )}

        {data.kind === "multiply" && (
          <NumberField spec={whole("times", "Сколько копий", 1, MAX_TIMES)} value={times(asNode)} disabled={readOnly}
            onChange={(v) => onChange({ times: v })} />
        )}

        {(data.kind === "split_share" || data.kind === "split_prob") && (
          <>
            <NumberField spec={whole("branches", "Веток", 2, MAX_BRANCHES)} value={branches(asNode)} disabled={readOnly}
              onChange={(v) => {
                // Новая ветка получает вес, средний по соседям: пустой читается единицей.
                const was = weights(asNode);
                const mean = Math.round(was.reduce((a, b) => a + b, 0) / was.length) || 1;
                const next = Array.from({ length: v }, (_, i) => was[i] ?? mean);
                onChange({ branches: v, [data.kind === "split_share" ? "shares" : "weights"]: next });
              }} />
            {weights(asNode).map((w, i) => (
              <NumberField key={i} spec={whole(`w${i}`, `Ветка ${i + 1}`, 0, 100)} value={w} disabled={readOnly}
                onChange={(v) => {
                  const next = weights(asNode).slice();
                  next[i] = v;
                  onChange(data.kind === "split_share" ? { shares: next } : { weights: next });
                }} />
            ))}
          </>
        )}

        {data.kind === "mosaic" && (() => {
          const g = grid(asNode);
          const field = (key: "rows" | "cols" | "width" | "height", label: string, low: number, high: number, step = 1) => (
            <NumberField key={key} spec={whole(key, label, low, high, step)} value={g[key]} disabled={readOnly}
              onChange={(v) => onChange({ [key]: v })} />
          );
          return (
            <>
              {field("rows", "Строк", 1, 4)}
              {field("cols", "Столбцов", 1, 4)}
              {field("width", "Ширина кадра, px", 64, 4096, 32)}
              {field("height", "Высота кадра, px", 64, 4096, 32)}
              {!readOnly && (
                <div className="ge-acts">
                  <Button size="sm" onClick={() => onChange({ fit: g.fit.map(() => "letterbox") })}>Все с полями</Button>
                  <Button size="sm" onClick={() => onChange({ fit: g.fit.map(() => "stretch") })}>Все растянуть</Button>
                  <Button size="sm" onClick={() => onChange({ col_w: null, row_h: null })}>Ячейки поровну</Button>
                </div>
              )}
            </>
          );
        })()}

        {(data.kind === "merge" || data.kind === "order") && (
          <NumberField spec={whole("inputs", "Входов", 2, MAX_INPUTS)} value={inputsCount(asNode)} disabled={readOnly}
            onChange={(v) => onChange({ inputs: v })} />
        )}
      </div>
    </section>
  );
}
