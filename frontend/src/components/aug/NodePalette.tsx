// Палитра узлов: колонка справа от холста — щелчок добавляет, перетаскивание ставит в нужное место.
//
// Недоступный узел не прячется, а показывается с причиной: человек, который
// вчера им пользовался, сразу видит — «нет в этой версии библиотеки».

import { useMemo, useState, type CSSProperties } from "react";
import type { Catalogue, NodeKind } from "../../api/aug";
import { Icon, Input, Notice, cx } from "../../ui";
import { NEUTRAL_TONE, iconOf, toneOf } from "./look";

interface Item {
  kind: NodeKind;
  label: string;
  params: Record<string, unknown>;
  group?: string;
  off?: string | null;
}

// Без «Источника» граф не с чего начать. «Вход блока» вернётся вместе с узлом «Блок».
const ENDS: Item[] = [
  { kind: "source", label: "Источник", params: { label: "Источник" } },
  { kind: "output", label: "Выход", params: { label: "Выход" } },
];

// «Слияние сеткой» — не трансформ albumentations, но по смыслу геометрия.
const MOSAIC: Item = {
  kind: "mosaic",
  label: "Слияние сеткой",
  params: { label: "Слияние сеткой", rows: 2, cols: 2, width: 1280, height: 1280 },
};

const FLOW: Item[] = [
  { kind: "multiply", label: "Умножение", params: { label: "Умножение", times: 3 } },
  { kind: "split_share", label: "Разделитель потока", params: { label: "Разделитель потока", branches: 2, shares: [50, 50] } },
  { kind: "split_prob", label: "Вероятностный", params: { label: "Вероятностный", branches: 2, weights: [70, 30] } },
  { kind: "merge", label: "Слияние", params: { label: "Слияние", inputs: 2 } },
  { kind: "order", label: "Порядок", params: { label: "Порядок", inputs: 2 } },
];

export const NODE_MIME = "application/mag-node";

export default function NodePalette({ catalogue, onPick, disabled }: {
  catalogue: Catalogue | null;
  onPick: (kind: string, params: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const out: { key: string; title: string; items: Item[] }[] = [{ key: "ends", title: "Начало и конец", items: ENDS }];
    for (const group of catalogue?.groups ?? []) {
      const items = (catalogue?.nodes ?? [])
        .filter((n) => n.group === group.key)
        .map<Item>((n) => ({
          kind: "aug",
          label: n.name,
          group: n.group,
          off: n.available ? null : n.reason,
          params: { op: n.op, label: n.name, chance: 1, args: Object.fromEntries(n.params.map((p) => [p.key, p.default])) },
        }));
      if (group.key === "geometry") items.push(MOSAIC);
      if (items.length) out.push({ ...group, items });
    }
    out.push({ key: "flow", title: "Поток", items: FLOW });
    return out;
  }, [catalogue]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return groups;
    return groups
      .map((g) => ({ ...g, items: g.items.filter((i) => i.label.toLowerCase().includes(needle)) }))
      .filter((g) => g.items.length);
  }, [groups, query]);

  return (
    <aside className="ge-pal" aria-label="Узлы">
      <div className="ge-pal-h">
        <span>Узлы</span>
        <span className="t-xs t-faint">щелчок или перетаскивание</span>
      </div>
      <Input icon="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти узел" aria-label="Найти узел" />
      {catalogue && !catalogue.available && (
        <Notice tone="error">Библиотека аугментаций на сервере не поднялась — узлы недоступны.</Notice>
      )}
      {shown.length === 0 && <p className="t-xs t-faint ge-pal-none">Такого узла нет</p>}
      {shown.map((group) => (
        <div key={group.key} className="ge-pal-g"
          style={{ "--gc": group.key === "ends" ? toneOf("source") : group.key === "flow" ? NEUTRAL_TONE : toneOf("aug", group.key) } as CSSProperties}>
          <h4><i aria-hidden="true" />{group.title}</h4>
          {group.items.map((item) => {
            const off = Boolean(item.off) || disabled;
            return (
              <div key={`${group.key}-${item.label}`} role="button" tabIndex={off ? -1 : 0} aria-disabled={off || undefined}
                className={cx("ge-pal-i", off && "off")} draggable={!off}
                title={item.off ?? (disabled ? "Граф открыт только для чтения" : "Щелчок — добавить, перетаскивание — поставить в нужное место")}
                onDragStart={(e) => {
                  e.dataTransfer.setData(NODE_MIME, JSON.stringify({ kind: item.kind, params: item.params }));
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => !off && onPick(item.kind, item.params)}
                onKeyDown={(e) => {
                  if (!off && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onPick(item.kind, item.params); }
                }}>
                <Icon name={iconOf(item.kind, item.group)} />
                <span className="t-ell">{item.label}</span>
                <span className="ge-pal-plus"><Icon name="plus" size={14} /></span>
              </div>
            );
          })}
        </div>
      ))}
    </aside>
  );
}
