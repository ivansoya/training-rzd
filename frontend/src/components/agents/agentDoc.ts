// Документ агента на стороне браузера: классы агента и их цвета.
// Проверка формы — на сервере (common/agent_graph.py) при сохранении версии.
// Здесь — только то, что нужно показывать, пока тянут провода, и заведомая
// неполнота (`unfinished`): превью не зовёт сервер ради ответа «не выбраны
// веса», который известен и так.

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

/** Порог строки с образцами по умолчанию. У YOLOE лучший F1 по образцам при
 *  0,05–0,15; у SAM 3 пусто — действует порог узла (0,1 давал сотни ложных масок). */
export const exampleConfDefault = (model: TextModel): number | undefined =>
  model === "sam3" ? undefined : 0.1;

/** Строка с образцами на пороге `conf`; undefined — без своего порога. */
export function withConf(r: PromptRow, conf: number | undefined): PromptRow {
  const { conf: _drop, ...rest } = r;
  return conf === undefined ? rest : { ...rest, conf };
}

/** Смена модели «Сети по тексту»: порог, стоявший на умолчании прежней
 *  модели, переходит на умолчание новой; правленый человеком остаётся.
 *  То же с порогами строк-образцов. */
export function switchTextModel(p: Record<string, unknown>, next: TextModel) {
  const was = textConfDefault(textModel(p));
  const conf = typeof p.conf === "number" && Number.isFinite(p.conf) ? p.conf : was;
  const from = exampleConfDefault(textModel(p));
  const to = exampleConfDefault(next);
  const rows = p.prompts as PromptRow[] | undefined;
  const prompts = rows?.map((r) =>
    isExamples(r) && (r.conf ?? undefined) === from ? withConf(r, to) : r);
  return {
    model: next,
    conf: conf === was ? textConfDefault(next) : conf,
    ...(prompts ? { prompts } : {}),
  };
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

export const TITLES: Record<string, string> = {
  frame: "Кадр",
  net: "Сеть",
  text: "Сеть по тексту",
  merge: "Объединение",
  nms: "NMS",
  filter: "Фильтр",
  sam: "Уточнение SAM",
  output: "Выход",
};

/** Имя узла с подписью: две «Сети» на холсте иначе не различить — ни на
 *  карточке, ни в ошибке сервера (agent_graph.title говорит так же). */
export function nodeTitle(type: string, params: Record<string, unknown> = {}) {
  const label = String(params.label ?? "").trim();
  return label ? `${TITLES[type] ?? type} — ${label}` : TITLES[type] ?? type;
}

// Как agent_graph.inputs_count.
export const mergeInputs = (params: Record<string, unknown>) =>
  Math.max(2, Math.min(8, Number(params.inputs ?? 2) || 2));

/** Входные гнёзда узла — как agent_graph.ports. */
export const inputsOf = (type: string, params: Record<string, unknown> = {}) =>
  type === "frame" ? [] : type === "merge" ? Array.from({ length: mergeInputs(params) }, (_, i) => `i${i}`) : ["in"];

/** «Входов» у «Объединения» стало меньше — провода в исчезнувшие гнёзда
 *  снимаются. Раньше провод оставался в i2 без гнезда на карточке, и узнавали
 *  о нём только по ошибке «Сохранить версию». */
export function keepWired<E extends { target: string; targetHandle?: string | null }>(
  edges: E[],
  node: string,
  params: Record<string, unknown>
): E[] {
  const ports = new Set(inputsOf("merge", params));
  return edges.filter((e) => e.target !== node || ports.has(e.targetHandle ?? ""));
}

/** Пределы числовых параметров — те же, что LIMITS в common/agent_graph.py:
 *  сервер по ним отвергает версию и превью, форма по ним не даёт выйти за край
 *  и подсвечивает старое значение, стоящее вне их. */
export interface Limit {
  lo: number;
  hi: number;
  int?: boolean;
}
const CONF: Limit = { lo: 0, hi: 1 };
const IMGSZ: Limit = { lo: 320, hi: 4096, int: true };
const PASSES = { overlap: { lo: 0, hi: 0.9 }, glue: { lo: 0.05, hi: 1 } };
const CONTOUR = { polygon_points: { lo: 8, hi: 200, int: true }, min_area: { lo: 0, hi: 1_000_000, int: true } };
export const LIMITS: Record<string, Record<string, Limit>> = {
  net: { conf: CONF, imgsz: IMGSZ, ...PASSES },
  text: { conf: CONF, imgsz: IMGSZ, ...PASSES, ...CONTOUR },
  merge: { inputs: { lo: 2, hi: 8, int: true } },
  nms: { iou: { lo: 0.05, hi: 1 } },
  filter: { min_side: { lo: 0, hi: 100_000, int: true }, max_side: { lo: 1, hi: 100_000, int: true } },
  sam: { score_min: CONF, ...CONTOUR },
};

/** Значение вне пределов (пустое — умолчание, это не ошибка). */
export function offLimits(limit: Limit | undefined, v: unknown) {
  if (!limit || v === null || v === undefined || v === "") return false;
  const n = typeof v === "number" ? v : Number.NaN;
  return !(n >= limit.lo && n <= limit.hi) || (Boolean(limit.int) && !Number.isInteger(n));
}

/** Чего заведомо не хватает графу, чтобы сервер его посчитал: первая такая
 *  вещь словами, или null. Проверяет только то, в чём сервер точно откажет, —
 *  всё остальное (веса на полке, наборы, SAM 3) по-прежнему решает он. */
export function unfinished(doc: {
  nodes: { id: string; type: string; params?: Record<string, unknown> }[];
  edges: { from: string; to: string; in: string }[];
}): string | null {
  if (!doc.nodes.some((n) => n.type === "net" || n.type === "text")) return "Добавьте «Сеть» или «Сеть по тексту».";
  for (const n of doc.nodes) {
    const p = n.params ?? {};
    const name = `«${nodeTitle(n.type, p)}»`;
    if (n.type === "net" && !p.weights) return `${name}: выберите веса.`;
    if (inputsOf(n.type, p).some((port) => !doc.edges.some((e) => e.to === n.id && e.in === port)))
      return `${name}: подключите вход.`;
    if (n.type !== "output" && !doc.edges.some((e) => e.from === n.id)) return `${name}: подключите выход.`;
    const bad = Object.entries(LIMITS[n.type] ?? {}).find(([k, lim]) => offLimits(lim, p[k]));
    if (bad) return `${name}: исправьте число в поле.`;
  }
  if (!agentClasses(doc.nodes, () => []).length) return "Включите хотя бы один класс у сети.";
  return null;
}

/** Таблица классов «Сети» для новых весов. Номера прежней к ним не относятся,
 *  но класс, чьё имя в весах совпало с прежним, забирает свою строку — имя в
 *  агенте и галочку: переобученные веса с теми же классами не должны стирать
 *  настройку. Прочие — имя из весов, включены. */
export function carryClasses(oldNames: string[], oldRows: NetRow[], names: string[]): NetRow[] {
  const kept = new Map<string, NetRow>();
  oldNames.forEach((n, i) => {
    if (oldRows[i] && !kept.has(n)) kept.set(n, oldRows[i]);
  });
  return names.map((n) => kept.get(n) ?? { agent: n, on: true });
}
