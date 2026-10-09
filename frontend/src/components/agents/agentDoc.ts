// Документ агента на стороне браузера: список классов агента и их цвета.
// Проверка формы — на сервере (common/agent_graph.py) при сохранении версии.
// Здесь — только то, что нужно показывать, пока тянут провода, и заведомая
// неполнота (`unfinished`): превью не зовёт сервер ради ответа «не выбраны
// веса», который известен и так.

import type { GraphNode } from "../../api/aug";

/** Строка таблицы «Сети»: класс агента по id. `agent` — подсказка имени у строки
 *  без класса (старый документ, новые веса): включат — класс найдётся или заведётся по ней. */
export interface NetRow {
  cls?: string;
  agent?: string;
  on: boolean;
}

/** Строка «Сети по тексту»: слово или набор образцов → класс агента.
 *  `conf` — свой порог строки; пусто — порог узла (common/agent_graph.row_conf). */
export interface PromptRow {
  kind?: "text" | "examples";
  prompt?: string;
  set?: string;
  cls?: string;
  agent?: string;
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
/** Предел описания в знаках — как agent_graph.PROMPT_MAX: кодировщик SAM 3 на 32 токена, YOLOE — на 77. */
export const promptMax = (model: TextModel) => (model === "sam3" ? 100 : 200);

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
    // SAM 3 без входа — новый для узла: 1008 (сервер без поля берёт 644, как у старых версий).
    ...(next === "sam3" && !SAM3_SIDES.includes(p.side as Sam3Side) ? { side: SAM3_NEW_SIDE } : {}),
    ...(prompts ? { prompts } : {}),
  };
}

export const promptsOf = (node: { params?: Record<string, unknown> }) =>
  ((node.params?.prompts as PromptRow[] | undefined) ?? []);

/** Строка «Фильтра» — по id класса агента. */
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

/** Ссылка на класс проекта: имя и цвет берутся из проекта, а там класс сопоставляется сам. */
export interface ClassRef {
  project: string;
  cls: string;
  project_name?: string;
}

/** Класс агента в списке документа (`doc.classes`), как в common/agent_graph.py. */
export interface ClassDef {
  id: string;
  name: string;
  color: string;
  ref?: ClassRef;
}

export interface AgentClass extends ClassDef {
  /** Откуда приходит: «№17 wagon» у сети, ««person»» у «Сети по тексту». Пусто — класс не используется. */
  sources: { node: string; index: number; label: string }[];
}

// Цвета новых классов — первый свободный из палитры; у документов до списка
// классов цвет давал порядок появления, и `upgradeDoc` раздаёт их так же.
export const PALETTE = [
  "#5AB0FF", "#E28CFF", "#7EE0C3", "#FF9F5A", "#F5D76E", "#9ED36A",
  "#FF7AA8", "#B48CFF", "#6FD6FF", "#FFB3A1", "#C8C1FF", "#8FE3A8",
];
export const CLASS_NAME_MAX = 60;

export const rowsOf = (node: GraphNode | { params?: Record<string, unknown> }) =>
  ((node.params?.classes as NetRow[] | undefined) ?? []);

/** Имена классов сравниваются без регистра — как `_fold` на сервере. */
export const foldName = (s?: string) => (s ?? "").trim().toLowerCase();

type DocNode = { id: string; type?: string; params?: Record<string, unknown> };

/** Включённая строка, что ищет объекты: у «Сети по тексту» — только с промтом или набором. */
const liveRow = (type: string | undefined, r: NetRow | PromptRow) =>
  r.on && (type !== "text" || Boolean(rowTarget(r as PromptRow)));

const rowsOfNode = (n: DocNode) => (n.type === "text" ? promptsOf(n) : rowsOf(n)) as (NetRow | PromptRow)[];

/** Документ до списка классов → со списком — как agent_graph.upgrade: классы по
 *  порядку появления включённых строк, цвета в том же порядке, строки по id. */
export function upgradeDoc<D extends { nodes: DocNode[]; classes?: ClassDef[] }>(doc: D): D & { classes: ClassDef[] } {
  if (Array.isArray(doc.classes)) return doc as D & { classes: ClassDef[] };
  const table = new Map<string, ClassDef>();
  const out: ClassDef[] = [];
  for (const n of doc.nodes) {
    if (n.type !== "net" && n.type !== "text") continue;
    for (const r of rowsOfNode(n)) {
      const key = foldName(r.agent);
      if (!liveRow(n.type, r) || !key || table.has(key)) continue;
      const c = { id: `c${out.length + 1}`, name: (r.agent ?? "").trim(), color: PALETTE[out.length % PALETTE.length] };
      table.set(key, c);
      out.push(c);
    }
  }
  const nodes = doc.nodes.map((n) => {
    if (n.type === "net" || n.type === "text") {
      const key = n.type === "text" ? "prompts" : "classes";
      const next = rowsOfNode(n).map((r) => {
        const hit = table.get(foldName(r.agent));
        if (!hit) return r;
        const { agent: _hint, ...rest } = r;
        return { ...rest, cls: hit.id };
      });
      return { ...n, params: { ...n.params, [key]: next } };
    }
    if (n.type === "filter") {
      const next = ((n.params?.classes as FilterRow[] | undefined) ?? [])
        .filter((r) => table.has(foldName(r.cls))).map((r) => ({ ...r, cls: table.get(foldName(r.cls))!.id }));
      return { ...n, params: { ...n.params, classes: next } };
    }
    return n;
  });
  return { ...doc, nodes, classes: out };
}

/** Классы агента из списка документа с источниками — какие строки узлов в них
 *  кладут находки. Номер класса сети дальше узла не идёт: две сети в одном
 *  классе — один класс, а номер 0 у двух сетей ничего не значит. */
export function agentClasses(defs: ClassDef[], nodes: DocNode[], weightsNames: (node: string) => string[]): AgentClass[] {
  const sources = new Map<string, AgentClass["sources"]>();
  const add = (cls: string | undefined, source: AgentClass["sources"][number]) => {
    if (!cls) return;
    if (!sources.has(cls)) sources.set(cls, []);
    sources.get(cls)!.push(source);
  };
  for (const node of nodes) {
    if (node.type === "net") {
      const names = weightsNames(node.id);
      rowsOf(node).forEach((row, index) => {
        if (row.on) add(row.cls, { node: node.id, index, label: `№${index} ${names[index] ?? index}` });
      });
    } else if (node.type === "text") {
      promptsOf(node).forEach((row, index) => {
        if (liveRow("text", row)) add(row.cls, { node: node.id, index, label: isExamples(row) ? "образцы" : `«${rowTarget(row)}»` });
      });
    }
  }
  return defs.map((c) => ({ ...c, sources: sources.get(c.id) ?? [] }));
}

const freshId = () => `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Цвет нового класса: первый свободный из палитры, все заняты — по кругу. */
export function nextColor(defs: ClassDef[]): string {
  const taken = new Set(defs.map((c) => c.color.toUpperCase()));
  return PALETTE.find((c) => !taken.has(c)) ?? PALETTE[defs.length % PALETTE.length];
}

/** Класс с таким именем (без регистра) — или новый свой. Id новых случайные:
 *  удалённый «c4» не должен вернуться другим классом с чужим сопоставлением. */
export function findOrCreate(defs: ClassDef[], name: string, extra?: Partial<ClassDef>): [ClassDef[], string | null] {
  const clean = name.trim().slice(0, CLASS_NAME_MAX);
  if (!clean) return [defs, null];
  const hit = defs.find((c) => foldName(c.name) === foldName(clean));
  if (hit) return [defs, hit.id];
  const made: ClassDef = { id: freshId(), name: clean, color: nextColor(defs), ...extra };
  return [[...defs, made], made.id];
}

/** Включённым строкам без класса — класс по подсказке имени или по `fallback`. */
export function bindRows<R extends NetRow | PromptRow>(defs: ClassDef[], rows: R[], fallback: (r: R, i: number) => string): [ClassDef[], R[]] {
  let next = defs;
  const out = rows.map((r, i) => {
    if (!r.on || (r.cls && next.some((c) => c.id === r.cls))) return r;
    const [grown, id] = findOrCreate(next, r.agent || fallback(r, i));
    next = grown;
    if (!id) return r;
    const { agent: _hint, ...rest } = r;
    return { ...rest, cls: id } as R;
  });
  return [next, out];
}

/** Классы из паспорта версии: старые версии хранят имена, новые — объекты. */
export function statClasses(list: unknown): { id?: string; name: string; color: string }[] {
  return (Array.isArray(list) ? list : []).map((c, i) =>
    typeof c === "string" ? { name: c, color: PALETTE[i % PALETTE.length] }
      : { id: c.id, name: String(c.name ?? ""), color: c.color ?? PALETTE[i % PALETTE.length] });
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
const PASSES = { tile: { lo: 160, hi: 4096, int: true }, overlap: { lo: 0, hi: 0.9 }, glue: { lo: 0.05, hi: 1 } };
const CONTOUR = { polygon_points: { lo: 8, hi: 200, int: true }, min_area: { lo: 0, hi: 1_000_000, int: true } };
export const LIMITS: Record<string, Record<string, Limit>> = {
  net: { conf: CONF, imgsz: IMGSZ, ...PASSES },
  text: { conf: CONF, imgsz: IMGSZ, ...PASSES, ...CONTOUR },
  merge: { inputs: { lo: 2, hi: 8, int: true } },
  nms: { iou: { lo: 0.05, hi: 1 } },
  filter: { min_side: { lo: 0, hi: 100_000, int: true }, max_side: { lo: 1, hi: 100_000, int: true } },
  sam: { score_min: CONF, ...CONTOUR },
};

// --- тайлинг: те же числа и счёт, что в common/agent_graph.py ------------------

export const TILE_OVERLAP = 0.2;
export const MAX_PASSES = 100;
// Вход SAM 3 — как agent_graph.SAM3_SIDES: без поля 644 (версии до переключателя), новые узлы — 1008.
export const SAM3_SIDES = [644, 1008] as const;
export type Sam3Side = (typeof SAM3_SIDES)[number];
export const SAM3_SIDE: Sam3Side = 644;
export const SAM3_NEW_SIDE: Sam3Side = 1008;
export const sam3Side = (p: Record<string, unknown>): Sam3Side =>
  SAM3_SIDES.includes(p.side as Sam3Side) ? (p.side as Sam3Side) : SAM3_SIDE;
/** «Слов за проход» у SAM 3 — как agent_graph.SAM3_WORDS; пусто — «Авто». */
export const SAM3_WORDS = [1, 2, 4, 8, 16] as const;
export const sam3Words = (p: Record<string, unknown>): number | null =>
  SAM3_WORDS.includes(p.words as (typeof SAM3_WORDS)[number]) ? (p.words as number) : null;
/** Умолчание «Авто» без карты: на 1008 по 4 слова, на 644 все разом (до 16). */
export const sam3DefaultWords = (p: Record<string, unknown>) => (sam3Side(p) === 1008 ? 4 : 16);
/** Слов за вызов — как sam3_words_per_call; `auto` — порция «Авто», выбранная сервером под карту. */
export const sam3WordsPerCall = (p: Record<string, unknown>, auto?: number) =>
  sam3Words(p) ?? auto ?? sam3DefaultWords(p);
/** Память SAM 3 при `atOnce` промтах в вызове — как agent_graph.sam3_mb (база + цена слова). */
export const sam3Mb = (p: Record<string, unknown>, atOnce: number) =>
  sam3Side(p) === 1008 ? 3600 + 850 * Math.max(1, atOnce) : 3000 + 150 * Math.max(1, atOnce);

const fin = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Сторона тайла — как tile_side: пусто — вход сети (у SAM 3 — его вход). */
export function tileSide(kind: string, p: Record<string, unknown>, netImgsz?: number | null): number {
  const own = fin(p.tile);
  if (own) return own;
  if (kind === "text") return textModel(p) === "sam3" ? sam3Side(p) : fin(p.imgsz) ?? TEXT_IMGSZ;
  return fin(p.imgsz) ?? netImgsz ?? 640;
}

/** Входная сторона сети: во сколько раз тайл растянут к ней. */
export function inputSide(kind: string, p: Record<string, unknown>, netImgsz?: number | null): number {
  if (kind === "text") return textModel(p) === "sam3" ? sam3Side(p) : fin(p.imgsz) ?? TEXT_IMGSZ;
  return fin(p.imgsz) ?? netImgsz ?? 640;
}

/** Образцов в ряду коллажа SAM 3 — как agent_examples.ROW. */
export const EX_ROW = 6;
/** Образцов за проход на виде w×h: второй ряд — в тот же проход, если коллаж не выше своей ширины. */
export const perPass = (w: number, h: number) => EX_ROW * (h + (2 * w) / EX_ROW <= w ? 2 : 1);

/** Номера образцов по проходам — как agent_examples.collage_passes. */
export function collagePasses(n: number, w: number, h: number): number[][] {
  const per = perPass(w, h);
  const out: number[][] = [];
  for (let at = 0; at < n; at += per) out.push(Array.from({ length: Math.min(per, n - at) }, (_, k) => at + k));
  return out;
}

const starts = (length: number, side: number, overlap: number) =>
  length <= side ? 1 : Math.ceil((length - side) / (side * (1 - overlap))) + 1;

/** Виды кадра — как views: целый (если не выключен) и тайлы. */
export function viewCount(p: Record<string, unknown>, w: number, h: number, side: number) {
  const whole = { whole: 1, tiles: 0 };
  if (!p.tiles || (w <= side && h <= side)) return whole;
  const overlap = Math.max(0, Math.min(0.9, fin(p.overlap) ?? TILE_OVERLAP));
  return { whole: p.whole === false ? 0 : 1, tiles: starts(w, side, overlap) * starts(h, side, overlap) };
}

/** Размеры видов кадра — как views: целый (если не выключен) и тайлы min(кадр, тайл). */
export function viewSizes(p: Record<string, unknown>, w: number, h: number, side: number): [number, number][] {
  const v = viewCount(p, w, h, side);
  const tile: [number, number] = [Math.min(w, side), Math.min(h, side)];
  return [...Array.from({ length: v.whole }, (): [number, number] => [w, h]), ...Array.from({ length: v.tiles }, () => tile)];
}

/** Вызовов модели на кадр — как agent_graph.calls: у SAM 3 на каждый вид слова порциями и проходы
 *  каждого набора образцов. `count` — образцов в наборе; не знаем — один проход. */
export function frameCalls(kind: string, p: Record<string, unknown>, w: number, h: number, side: number,
  count?: (set: string) => number | undefined): number {
  const views = viewSizes(p, w, h, side);
  if (kind !== "text" || textModel(p) !== "sam3") return views.length;
  const rows = promptsOf({ params: p }).filter((r) => r.on && rowTarget(r) && r.cls);
  const sets = rows.filter(isExamples).map((r) => Math.max(1, count?.(rowTarget(r)) ?? 1));
  const words = Math.ceil((rows.length - sets.length) / sam3WordsPerCall(p));
  return views.reduce((sum, [vw, vh]) => sum + words + sets.reduce((s, n) => s + collagePasses(n, vw, vh).length, 0), 0);
}

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
  classes?: ClassDef[];
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
    // Как _check_text: только включённые описания с классом.
    const max = promptMax(textModel(p));
    if (n.type === "text" && promptsOf(n).some((r) => r.on && r.cls && !isExamples(r) && rowTarget(r).length > max))
      return `${name}: описание длиннее ${max} знаков.`;
  }
  const up = upgradeDoc(doc);
  const used = agentClasses(up.classes, up.nodes, () => []).filter((c) => c.sources.length);
  if (!used.length) return "Включите хотя бы один класс у сети.";
  return null;
}

/** Таблица классов «Сети» для новых весов. Номера прежней к ним не относятся,
 *  но класс, чьё имя в весах совпало с прежним, забирает свою строку — класс
 *  агента и галочку: переобученные веса с теми же классами не должны стирать
 *  настройку. Прочие включены с подсказкой — именем из весов (класс даст `bindRows`). */
export function carryClasses(oldNames: string[], oldRows: NetRow[], names: string[]): NetRow[] {
  const kept = new Map<string, NetRow>();
  oldNames.forEach((n, i) => {
    if (oldRows[i] && !kept.has(n)) kept.set(n, oldRows[i]);
  });
  return names.map((n) => kept.get(n) ?? { agent: n, on: true });
}
