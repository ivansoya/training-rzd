// Графы аугментаций: личная библиотека, версии и каталог узлов.

import { del, get, patch, post, put } from "./http";

export type NodeKind =
  | "source"
  | "input"
  | "aug"
  | "flow"
  | "multiply"
  | "split_share"
  | "split_prob"
  | "merge"
  | "order"
  | "output"
  | "group"
  | "mosaic";

export interface GraphNode {
  id: string;
  type: NodeKind;
  params?: Record<string, unknown>;
  pos?: [number, number];
}

export interface GraphEdge {
  from: string;
  out: string;
  to: string;
  in: string;
}

export interface GraphDoc {
  v?: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphStats {
  outputs: number;
  dropped: number;
  multiplier: number;
  nodes: number;
  source_count?: number;
  /** «Источники» графа: номер узла и подпись. По ним мастер сборки
   *  спрашивает, что вливать в каждый. У версий, сохранённых до
   *  13.09.2026, поля нет — там источник ровно один и безымянный. */
  sources?: { id: string; name: string }[];
  edges?: Record<string, number>;
}

export interface GraphSummary {
  id: string;
  name: string;
  description: string | null;
  owner: string | null;
  owner_id: string | null;
  archived: boolean;
  created_at: string;
  version: number;
  version_id: string | null;
  stats: GraphStats | null;
  ports: { in: string[]; out: string[] };
  used_by_sets: number;
}

export interface GraphDetail extends GraphSummary {
  doc: GraphDoc;
  mine: boolean;
  /** Когда сохранилась настоящая копия; пусто — она совпадает с версией. */
  draft_at?: string | null;
  /** В настоящей копии есть правки, которых нет ни в одной версии. */
  changed?: boolean;
}

export interface VersionRow {
  id: string;
  version: number;
  note: string | null;
  stats: GraphStats | null;
  author: string | null;
  created_at: string;
}

export interface ParamSpec {
  key: string;
  label: string;
  hint?: string | null;
  kind: "range" | "number" | "flag" | "choice";
  low?: number;
  high?: number;
  step?: number | null;
  int?: boolean;
  options?: string[];
  default: unknown;
}

export interface CatalogueNode {
  op: string;
  name: string;
  group: string;
  group_title: string;
  why: string;
  available: boolean;
  reason: string | null;
  params: ParamSpec[];
  chance: ParamSpec;
}

export interface Catalogue {
  available: boolean;
  groups: { key: string; title: string }[];
  nodes: CatalogueNode[];
}

export const catalogue = () => get<Catalogue>("aug/catalogue");

export const listGraphs = () =>
  get<{ graphs: GraphSummary[] }>("aug/graphs");

export const createGraph = (name: string, description?: string) =>
  post<GraphSummary>("aug/graphs", { name, description });

export const getGraph = (id: string, version?: string) =>
  get<GraphDetail>(`aug/graphs/${id}${version ? `?version=${version}` : ""}`);

export const listVersions = (id: string) =>
  get<{ versions: VersionRow[] }>(`aug/graphs/${id}/versions`);

// Версию создаёт явное сохранение, а не автосохранение черновика: иначе за
// вечер накопится тридцать версий, и запись «набор собран версией 7» перестанет
// что-либо значить. Тот же документ второй раз версии не порождает — сервер
// сравнивает отпечаток.
export const saveVersion = (id: string, doc: GraphDoc, note?: string) =>
  post<GraphDetail & { fresh: boolean }>(`aug/graphs/${id}/versions`, {
    doc,
    note,
  });

// Настоящая копия — на каждой правке, мимо версий. `leaving` — последняя
// правка при уходе со страницы: keepalive дотянет её, но только до 64 КБ,
// поэтому обычное сохранение идёт без него.
export const saveDraft = (id: string, doc: GraphDoc, leaving = false) =>
  put<{ draft_at: string; changed: boolean }>(`aug/graphs/${id}/draft`, { doc }, leaving);

export const patchGraph = (
  id: string,
  data: { name?: string; description?: string; archived?: boolean; head_version_id?: string }
) => patch<GraphSummary>(`aug/graphs/${id}`, data);

export const deleteGraph = (id: string) => del<{ ok: true }>(`aug/graphs/${id}`);

// Счёт на сервере нужен только графам с блоками: их содержимое лежит в базе.
// Всё остальное браузер считает сам — см. components/aug/counts.ts.
export const serverCounts = (doc: GraphDoc, base: number) =>
  post<GraphStats>("aug/counts", { doc, base });

export const projectGraphs = (code: string) =>
  get<{ graphs: GraphSummary[]; mine: GraphSummary[]; role: string }>(
    `projects/${code}/aug`
  );

export const linkGraph = (code: string, graphId: string) =>
  post<GraphSummary>(`projects/${code}/aug`, { graph_id: graphId });

export const unlinkGraph = (code: string, graphId: string) =>
  del<{ ok: true }>(`projects/${code}/aug/${graphId}`);

// Превью узла: один кадр через граф — что выходит из выбранного узла.
// Считает сервер тем же исполнителем, что и сборку, см.
// dataprep_svc/preview.py.

export interface PreviewShape {
  c: number;
  box?: [number, number, number, number];
  rings?: [number, number][][];
}

export interface PreviewPic {
  pic: number;
  shapes: PreviewShape[];
  objects: number;
}

/** Шаг пути образца: преобразование (`fired` — что сработало, `null` —
 *  неизвестно) или копия «Умножения». */
export interface PreviewStep {
  node: string;
  ops: string[];
  fired?: string[] | null;
  copy?: number;
  /** «Слияние сеткой»: сколько ячеек сложено в кадр. */
  cells?: number;
}

export interface PreviewFrame {
  kind: "project" | "test";
  project?: string;
  project_name?: string;
  image?: string;
  name?: string;
  width: number;
  height: number;
}

export interface PreviewResult {
  frame: PreviewFrame;
  classes: { name: string; color: string }[];
  reached: boolean;
  pics?: { url: string; w: number; h: number }[];
  original?: PreviewPic;
  total?: number;
  dropped?: Record<string, number>;
  samples?: {
    sid: string;
    after: PreviewPic;
    before: PreviewPic;
    trail: PreviewStep[];
  }[];
}

export const previewProjects = (graphId: string) =>
  get<{ projects: { code: string; name: string; linked: boolean }[] }>(
    `aug/preview/projects?graph=${graphId}`
  );

export const preview = (
  body: {
    doc: GraphDoc;
    node: string;
    seed: number;
    frame: { project: string; image?: string | null } | null;
  },
  signal?: AbortSignal
) => post<PreviewResult>("aug/preview", body, signal);
