// Документ агента на стороне браузера: классы агента и их цвета.
// Проверка формы — на сервере (common/agent_graph.py) при сохранении версии:
// здесь только то, что нужно показывать, пока тянут провода.

import type { GraphNode } from "../../api/aug";

export interface NetRow {
  agent: string;
  on: boolean;
}

/** Строка «Фильтра» — по имени класса агента, а не по номеру. */
export interface FilterRow {
  cls: string;
  on: boolean;
  conf: number;
}

// Как в common/agent_graph.py: SAM_MODELS и SAM_DEFAULTS — это настройки
// полуавтомата в редакторе таски, чтобы одна рамка давала один контур.
export const SAM_MODELS: [string, string][] = [
  ["sam2.1_hiera_tiny", "SAM2.1 tiny"],
  ["sam2.1_hiera_small", "SAM2.1 small"],
  ["sam2.1_hiera_base_plus", "SAM2.1 base+"],
  ["sam2.1_hiera_large", "SAM2.1 large"],
];
export const SAM_DEFAULTS = {
  model: "sam2.1_hiera_small",
  detail: "auto",
  score_min: 0.3,
  min_area: 64,
  fill_holes: true,
  polygon_points: 64,
};

/** Все узлы выше данного: классы их сетей и приходят к нему по проводу. */
export function upstream(
  id: string,
  edges: { from: string; to: string }[]
): Set<string> {
  const seen = new Set<string>();
  const todo = [id];
  while (todo.length) {
    const cur = todo.pop()!;
    for (const e of edges) if (e.to === cur && !seen.has(e.from)) {
      seen.add(e.from);
      todo.push(e.from);
    }
  }
  return seen;
}

export interface AgentClass {
  name: string;
  color: string;
  /** Откуда пришёл: «Путь-v4 №17 wagon». */
  sources: { node: string; index: number; weightsName: string }[];
}

// Цвета классов агента — по порядку появления. Пересчитываются вместе со
// списком, поэтому класс может сменить цвет, если выше в графе появился новый:
// это цвет подсказки на холсте, а не цвет класса проекта.
export const PALETTE = [
  "#5AB0FF", "#E28CFF", "#7EE0C3", "#FF9F5A", "#F5D76E", "#9ED36A",
  "#FF7AA8", "#B48CFF", "#6FD6FF", "#FFB3A1", "#C8C1FF", "#8FE3A8",
];

export const rowsOf = (node: GraphNode | { params?: Record<string, unknown> }) =>
  ((node.params?.classes as NetRow[] | undefined) ?? []);

/** Классы агента: объединение включённых классов всех сетей по имени.
 *  Номер класса сети дальше узла не идёт — одно имя у двух сетей это один
 *  класс, а номер 0 у двух сетей ничего не значит. */
export function agentClasses(
  nodes: { id: string; type?: string; params?: Record<string, unknown> }[],
  weightsNames: (node: string) => string[]
): AgentClass[] {
  const found = new Map<string, AgentClass>();
  for (const node of nodes) {
    if (node.type !== "net") continue;
    const names = weightsNames(node.id);
    rowsOf(node).forEach((row, index) => {
      const name = row.agent.trim();
      if (!row.on || !name) return;
      if (!found.has(name)) found.set(name, { name, color: "", sources: [] });
      found.get(name)!.sources.push({ node: node.id, index, weightsName: names[index] ?? String(index) });
    });
  }
  return [...found.values()].map((c, i) => ({ ...c, color: PALETTE[i % PALETTE.length] }));
}
