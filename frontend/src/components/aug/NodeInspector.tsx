// Инспектор выбранного узла: параметры по схеме реестра.
//
// Пределы приходят с сервера и уже приведены к установленной версии
// библиотеки: ползунок обязан ходить по настоящей шкале, а не по той, что
// была верна год назад. Ввести значение вне пределов нельзя — сервер его всё
// равно загнёт обратно, и расхождение выглядело бы как «поле не сохраняется».

import type { Node } from "@xyflow/react";
import type { Catalogue, ParamSpec } from "../../api/aug";
import type { Counts } from "./counts";
import { branches, inputsCount, times, weights } from "./counts";
import type { NodeData } from "./GraphNodes";

const fmt = (v: number, spec?: ParamSpec) =>
  spec?.int ? String(Math.round(v)) : v.toFixed(2).replace(".", ",");

function Number_({
  spec,
  value,
  onChange,
  disabled,
}: {
  spec: ParamSpec;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const low = spec.low ?? 0;
  const high = spec.high ?? 1;
  return (
    <div className="g-field">
      <div className="k">
        <span>{spec.label}</span>
        <b>{fmt(value, spec)}</b>
      </div>
      <input
        type="range"
        min={low}
        max={high}
        step={spec.step ?? (spec.int ? 1 : 0.01)}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {spec.hint && <div className="hint">{spec.hint}</div>}
    </div>
  );
}

function Range_({
  spec,
  value,
  onChange,
  disabled,
}: {
  spec: ParamSpec;
  value: [number, number];
  onChange: (v: [number, number]) => void;
  disabled?: boolean;
}) {
  const low = spec.low ?? 0;
  const high = spec.high ?? 1;
  const step = spec.step ?? (spec.int ? 1 : 0.01);
  const [a, b] = value;
  return (
    <div className="g-field">
      <div className="k">
        <span>{spec.label}</span>
        <b>
          {fmt(a, spec)} — {fmt(b, spec)}
        </b>
      </div>
      <div className="pair">
        <input
          type="range"
          min={low}
          max={high}
          step={step}
          value={a}
          disabled={disabled}
          aria-label={`${spec.label}, от`}
          onChange={(e) => onChange([Math.min(Number(e.target.value), b), b])}
        />
        <input
          type="range"
          min={low}
          max={high}
          step={step}
          value={b}
          disabled={disabled}
          aria-label={`${spec.label}, до`}
          onChange={(e) => onChange([a, Math.max(Number(e.target.value), a)])}
        />
      </div>
      {spec.hint && <div className="hint">{spec.hint}</div>}
    </div>
  );
}

export default function NodeInspector({
  node,
  catalogue,
  readOnly,
  totals,
  onChange,
  onRemove,
}: {
  node: Node | null;
  catalogue: Catalogue | null;
  readOnly?: boolean;
  totals: Counts | null;
  onChange: (next: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  if (!node) {
    return (
      <aside className="g-insp">
        <div className="g-label" style={{ marginBottom: 9 }}>
          Узел
        </div>
        <p className="g-insp-why">
          Выберите узел на холсте — здесь будут его параметры. Числа на проводах
          пересчитываются сразу, до запуска.
        </p>
        {totals && (
          <>
            <div className="g-label" style={{ margin: "18px 0 8px" }}>
              Весь граф
            </div>
            <div className="g-kv">
              <span>узлов</span>
              <b>{totals.nodes}</b>
            </div>
            <div className="g-kv">
              <span>во сколько раз</span>
              <b>×{totals.multiplier.toLocaleString("ru-RU")}</b>
            </div>
            <div className="g-kv">
              <span>брошено</span>
              <b>{Math.round(totals.dropped).toLocaleString("ru-RU")}</b>
            </div>
          </>
        )}
      </aside>
    );
  }

  const data = node.data as NodeData;
  const params = data.params ?? {};
  const cat = (catalogue?.nodes ?? []).find((n) => n.op === params.op);
  const asNode = { id: node.id, type: data.kind, params } as const;

  const setArg = (key: string, value: unknown) =>
    onChange({ args: { ...((params.args as object) ?? {}), [key]: value } });

  return (
    <aside className="g-insp">
      <div className="g-label" style={{ marginBottom: 9 }}>
        Узел
      </div>
      <div className="g-insp-name">
        {cat?.name ?? (params.label as string) ?? data.kind}
      </div>
      {cat?.why && <p className="g-insp-why">{cat.why}</p>}

      {data.kind === "aug" && cat && (
        <>
          {cat.params.map((spec) => {
            const args = (params.args as Record<string, unknown>) ?? {};
            const value = args[spec.key] ?? spec.default;
            if (spec.kind === "range") {
              return (
                <Range_
                  key={spec.key}
                  spec={spec}
                  value={value as [number, number]}
                  disabled={readOnly}
                  onChange={(v) => setArg(spec.key, v)}
                />
              );
            }
            if (spec.kind === "number") {
              return (
                <Number_
                  key={spec.key}
                  spec={spec}
                  value={Number(value)}
                  disabled={readOnly}
                  onChange={(v) => setArg(spec.key, v)}
                />
              );
            }
            if (spec.kind === "flag") {
              return (
                <div className="g-sw" key={spec.key}>
                  <span>{spec.label}</span>
                  <input
                    type="checkbox"
                    checked={Boolean(value)}
                    disabled={readOnly}
                    onChange={(e) => setArg(spec.key, e.target.checked)}
                  />
                </div>
              );
            }
            return null;
          })}
          <Number_
            spec={{ ...cat.chance, key: "chance", label: "Как часто" } as ParamSpec}
            value={Number(params.chance ?? 1)}
            disabled={readOnly}
            onChange={(v) => onChange({ chance: v })}
          />
        </>
      )}

      {(data.kind === "source" ||
        data.kind === "input" ||
        data.kind === "output" ||
        data.kind === "flow") && (
        <div className="mag-field">
          <label>Подпись</label>
          <input
            value={(params.name as string) ?? (params.label as string) ?? ""}
            disabled={readOnly}
            onChange={(e) =>
              onChange(
                // У «Входа» и «Выхода» подпись — это ещё и имя гнезда, когда
                // граф вставляют блоком. Пишем в оба поля: сервер читает name,
                // холст — label, и расходиться им нельзя.
                data.kind === "input" || data.kind === "output"
                  ? { name: e.target.value, label: e.target.value }
                  : { label: e.target.value }
              )
            }
          />
        </div>
      )}

      {data.kind === "multiply" && (
        <Number_
          spec={{
            key: "times",
            label: "Сколько копий",
            kind: "number",
            low: 1,
            high: 32,
            int: true,
            default: 3,
            hint: "×3 значит ровно три копии, а не «оригинал плюс три». "
              + "Оригинал попадёт в набор, только если провести его отдельным проводом.",
          }}
          value={times(asNode)}
          disabled={readOnly}
          onChange={(v) => onChange({ times: v })}
        />
      )}

      {(data.kind === "split_share" || data.kind === "split_prob") && (
        <>
          <Number_
            spec={{
              key: "branches",
              label: "Веток",
              kind: "number",
              low: 2,
              high: 8,
              int: true,
              default: 2,
            }}
            value={branches(asNode)}
            disabled={readOnly}
            onChange={(v) => onChange({ branches: v })}
          />
          {weights(asNode).map((w, i) => (
            <Number_
              key={i}
              spec={{
                key: `w${i}`,
                label: `Ветка ${i + 1}`,
                kind: "number",
                low: 0,
                high: 100,
                int: true,
                default: 50,
              }}
              value={w}
              disabled={readOnly}
              onChange={(v) => {
                const next = weights(asNode).slice();
                next[i] = v;
                onChange(
                  data.kind === "split_share"
                    ? { shares: next }
                    : { weights: next }
                );
              }}
            />
          ))}
          <p className="hint" style={{ color: "var(--faint)", fontSize: 11 }}>
            {data.kind === "split_share"
              ? "Каждый кадр уходит ровно в одну ветку. Доли соблюдаются точно: ветка «30 %» из тысячи получит триста кадров, а не «около трёхсот»."
              : "Каждый кадр уходит ровно в одну ветку жребием. Один и тот же кадр при том же зерне всегда уходит в ту же сторону."}
          </p>
        </>
      )}

      {(data.kind === "merge" || data.kind === "order") && (
        <Number_
          spec={{
            key: "inputs",
            label: "Входов",
            kind: "number",
            low: 2,
            high: 8,
            int: true,
            default: 2,
            hint:
              data.kind === "merge"
                ? "Потоки идут вперемешку: прервали сборку — в наборе обе ветки."
                : "Сперва вся первая ветка, потом вторая. На состав набора не влияет, на порядок файлов — да.",
          }}
          value={inputsCount(asNode)}
          disabled={readOnly}
          onChange={(v) => onChange({ inputs: v })}
        />
      )}

      <div className="g-label" style={{ margin: "18px 0 8px" }}>
        Через этот узел
      </div>
      <div className="g-kv">
        <span>выйдет</span>
        <b>
          {totals
            ? Math.round(
                Object.entries(totals.edges)
                  .filter(([k]) => k.startsWith(`${node.id}:`))
                  .reduce((a, [, v]) => a + v, 0)
              ).toLocaleString("ru-RU")
            : "—"}
        </b>
      </div>

      {!readOnly && (
        <button
          type="button"
          className="mag-ghost"
          style={{ marginTop: 16, width: "100%" }}
          onClick={onRemove}
        >
          Убрать узел
        </button>
      )}
    </aside>
  );
}
