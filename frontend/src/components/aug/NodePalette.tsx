// Палитра узлов: дерево слева, из которого узлы тянут на холст.
//
// Недоступный узел не прячется, а показывается с причиной. Прятать хуже:
// человек, который вчера им пользовался, решит, что сошёл с ума, а так он
// сразу видит — «нет в этой версии библиотеки».

import { useMemo, useState } from "react";
import type { Catalogue } from "../../api/aug";

interface Item {
  kind: string;
  label: string;
  klass: string;
  params: Record<string, unknown>;
  off?: string | null;
}

// Начало и конец потока. Без «Источника» граф не с чего начать, а поставить
// его было неоткуда: в списке лежал один «Выход». «Вход» — гнездо графа,
// который вставляют в другой граф блоком; в корневом графе сервер его не
// примет и скажет об этом прямо.
const ENDS: Item[] = [
  {
    kind: "source",
    label: "Источник",
    klass: "k-source",
    params: { label: "Источник" },
  },
  {
    kind: "output",
    label: "Выход",
    klass: "k-output",
    params: { label: "Выход" },
  },
  {
    kind: "input",
    label: "Вход блока",
    klass: "k-source",
    params: { label: "Вход", name: "Вход" },
  },
];

const FLOW: Item[] = [
  {
    kind: "multiply",
    label: "Умножение",
    klass: "k-flow",
    params: { label: "Умножение", times: 3 },
  },
  {
    kind: "split_share",
    label: "Разделитель потока",
    klass: "k-flow",
    params: { label: "Разделитель потока", branches: 2, shares: [50, 50] },
  },
  {
    kind: "split_prob",
    label: "Вероятностный",
    klass: "k-flow",
    params: { label: "Вероятностный", branches: 2, weights: [70, 30] },
  },
  {
    kind: "merge",
    label: "Слияние",
    klass: "k-flow",
    params: { label: "Слияние", inputs: 2 },
  },
  {
    kind: "order",
    label: "Порядок",
    klass: "k-flow",
    params: { label: "Порядок", inputs: 2 },
  },
  {
    kind: "flow",
    label: "Поток",
    klass: "k-flow",
    params: { label: "Поток", ops: [] },
  },
];

export default function NodePalette({
  catalogue,
  onPick,
  disabled,
}: {
  catalogue: Catalogue | null;
  onPick: (kind: string, params: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const out: { key: string; title: string; items: Item[] }[] = [
      { key: "ends", title: "Начало и конец", items: ENDS },
    ];
    for (const group of catalogue?.groups ?? []) {
      const items = (catalogue?.nodes ?? [])
        .filter((n) => n.group === group.key)
        .map<Item>((n) => ({
          kind: "aug",
          label: n.name,
          klass: `k-${n.group}`,
          off: n.available ? null : n.reason,
          params: {
            op: n.op,
            label: n.name,
            chance: 1,
            args: Object.fromEntries(n.params.map((p) => [p.key, p.default])),
          },
        }));
      if (items.length) out.push({ ...group, items });
    }
    out.push({ key: "flow", title: "Поток", items: FLOW });
    return out;
  }, [catalogue]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return groups;
    return groups
      .map((g) => ({
        ...g,
        items: g.items.filter((i) => i.label.toLowerCase().includes(needle)),
      }))
      .filter((g) => g.items.length);
  }, [groups, query]);

  return (
    <aside className="g-pal">
      <div className="g-pal-search">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск узла"
          aria-label="Поиск узла"
        />
      </div>

      {catalogue && !catalogue.available && (
        <div className="mag-error" style={{ margin: "10px" }}>
          Библиотека аугментаций на сервере не поднялась — узлы недоступны.
        </div>
      )}

      {shown.map((group) => (
        <div key={group.key}>
          <h4>{group.title}</h4>
          {group.items.map((item) => (
            <button
              key={`${group.key}-${item.label}`}
              type="button"
              className={`g-pal-item ${item.klass}${item.off ? " off" : ""}`}
              title={item.off ?? "Перетащите на холст или щёлкните"}
              draggable={!item.off && !disabled}
              disabled={Boolean(item.off) || disabled}
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  "application/mag-node",
                  JSON.stringify({ kind: item.kind, params: item.params })
                );
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => !item.off && onPick(item.kind, item.params)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ))}
    </aside>
  );
}
