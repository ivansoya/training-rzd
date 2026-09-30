// Документ агента на стороне браузера: классы агента и их цвета.
// Проверка формы — на сервере (common/agent_graph.py) при сохранении версии:
// здесь только то, что нужно показывать, пока тянут провода.

import type { GraphNode } from "../../api/aug";

export interface NetRow {
  agent: string;
  on: boolean;
}

/** Строка «Сети по тексту»: слово или набор образцов → класс агента.
 *  `conf` — свой порог строки; пусто — порог узла (common/agent_graph.row_conf). */
export interface PromptRow {
  kind?: "text" | "examples";
  prompt?: string;
  set?: string;
  agent: string;
  on: boolean;
  conf?: number | null;
}

export const isExamples = (r: PromptRow) => r.kind === "examples";
/** Что ищет строка: промт или id набора; пусто — строка не в счёт. */
export const rowTarget = (r: PromptRow) => ((isExamples(r) ? r.set : r.prompt) ?? "").trim();

// Как в common/agent_graph.py: TEXT_MODELS, TEXT_CONF, TEXT_IMGSZ.
export const TEXT_MODELS = ["s", "m", "l", "x", "sam3"] as const;
export type TextModel = (typeof TEXT_MODELS)[number];
export const TEXT_MODEL: TextModel = "l";
export const TEXT_IMGSZ = 1280;
export const textModel = (p: Record<string, unknown>): TextModel =>
  TEXT_MODELS.includes(p.model as TextModel) ? (p.model as TextModel) : TEXT_MODEL;
/** Порог по умолчанию у модели: шкалы уверенности у YOLOE и SAM 3 разные. */
export const textConfDefault = (model: TextModel) => (model === "sam3" ? 0.4 : 0.25);
// Размер весов — для строки о весах в узле; файлы лежат в образе.
export const YOLOE_MB: Record<string, number> = { s: 31, m: 70, l: 79, x: 172 };
/** Кириллица в промте: модель понимает английский — предупредить, не запрещать. */
export const CYRILLIC = /[а-яё]/i;

/** Смена модели «Сети по тексту»: порог, стоявший на умолчании прежней
 *  модели, переходит на умолчание новой; правленый человеком остаётся. */
export function switchTextModel(p: Record<string, unknown>, next: TextModel) {
  const was = textConfDefault(textModel(p));
  const conf = typeof p.conf === "number" && Number.isFinite(p.conf) ? p.conf : was;
  return { model: next, conf: conf === was ? textConfDefault(next) : conf };
}

export const promptsOf = (node: { params?: Record<string, unknown> }) =>
  ((node.params?.prompts as PromptRow[] | undefined) ?? []);

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
  /** Откуда пришёл: «№17 wagon» у сети, ««person»» у «Сети по тексту». */
  sources: { node: string; index: number; label: string }[];
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
 *  класс, а номер 0 у двух сетей ничего не значит. У «Сети по тексту» строка
 *  без промта класса не даёт — как `net_classes` на сервере. */
export function agentClasses(
  nodes: { id: string; type?: string; params?: Record<string, unknown> }[],
  weightsNames: (node: string) => string[]
): AgentClass[] {
  const found = new Map<string, AgentClass>();
  const add = (name: string, source: AgentClass["sources"][number]) => {
    if (!found.has(name)) found.set(name, { name, color: "", sources: [] });
    found.get(name)!.sources.push(source);
  };
  for (const node of nodes) {
    if (node.type === "net") {
      const names = weightsNames(node.id);
      rowsOf(node).forEach((row, index) => {
        const name = row.agent.trim();
        if (row.on && name) add(name, { node: node.id, index, label: `№${index} ${names[index] ?? index}` });
      });
    } else if (node.type === "text") {
      promptsOf(node).forEach((row, index) => {
        const name = row.agent.trim();
        if (!row.on || !name || !rowTarget(row)) return;
        add(name, { node: node.id, index, label: isExamples(row) ? "образцы" : `«${rowTarget(row)}»` });
      });
    }
  }
  return [...found.values()].map((c, i) => ({ ...c, color: PALETTE[i % PALETTE.length] }));
}
