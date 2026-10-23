// Окно «Образцы класса»: что показать плитками и что добрать случайно.
// Группа (`ClassBox.group`) — тот же предмет на соседних кадрах ролика (agent_examples.same_object_groups).

import { boxCrop, pictureCrop } from "../../api/agents";
import type { ClassBox, ExampleItem, ExampleRef, Picture } from "../../api/agents";
import type { TextModel } from "./agentDoc";

export type Band = "all" | "small" | "mid" | "big";

export const BANDS: { value: Band; label: string }[] = [
  { value: "all", label: "все" },
  { value: "small", label: "до 40 px" },
  { value: "mid", label: "40–200" },
  { value: "big", label: "больше 200" },
];

/** SAM 3 берёт все образцы рядами по 6; YOLOE сводит их в средний вектор — ему нужно больше. */
/** Потолок набора на сервере (agents.MAX_EXAMPLES). */
export const MAX_SET = 256;
/** «Случайно»: SAM 3 — ряд из 6; YOLOE сводит образцы в средний вектор — сразу все разные предметы. */
export const addFor = (model: TextModel) => (model === "sam3" ? 6 : MAX_SET);
/** Плитка-кнопка: SAM 3 — по одной; YOLOE — все разные, сколько осталось до потолка. */
export const stepFor = (model: TextModel, have: number) => (model === "sam3" ? 1 : Math.max(0, MAX_SET - have));

/** Образец в наборе: кадр проекта или своя картинка и рамка; `group` есть, только если рамка из списка плиток. */
export interface Picked {
  uid: string;
  image_id: string | null;
  picture_id?: string | null;
  box: [number, number, number, number];
  file_name: string;
  group?: number;
}

/** Полоса размера — по большей стороне: пруток 42×199 — «40–200», гайка 30×27 — «до 40». */
export function bandOf(box: [number, number, number, number]): Exclude<Band, "all"> {
  const long = Math.max(box[2], box[3]);
  return long < 40 ? "small" : long <= 200 ? "mid" : "big";
}

export function filterBoxes(boxes: ClassBox[], band: Band, offDatasets: Set<string>): ClassBox[] {
  return boxes.filter((b) => (band === "all" || bandOf(b.box) === band) && !offDatasets.has(b.dataset));
}

export interface Tile { box: ClassBox; members: ClassBox[] }

/** Плитки галереи; `merged` — одна на группу, представитель — середина серии. */
export function tilesOf(boxes: ClassBox[], merged: boolean): Tile[] {
  if (!merged) return boxes.map((b) => ({ box: b, members: [b] }));
  const groups = new Map<number, ClassBox[]>();
  for (const b of boxes) groups.set(b.group, [...(groups.get(b.group) ?? []), b]);
  return [...groups.values()].map((members) => ({ box: members[Math.floor((members.length - 1) / 2)], members }));
}

/** До `n` новых рамок, не больше одной из группы и ни одной из групп, что уже в наборе. */
export function randomDistinct(pool: ClassBox[], chosen: Picked[], n: number, rand: () => number = Math.random): ClassBox[] {
  const taken = new Set(chosen.map((p) => p.uid));
  const busy = new Set(chosen.flatMap((p) => (p.group === undefined ? [] : [p.group])));
  const groups = new Map<number, ClassBox[]>();
  for (const b of pool) {
    if (taken.has(b.uid) || busy.has(b.group)) continue;
    groups.set(b.group, [...(groups.get(b.group) ?? []), b]);
  }
  const order = [...groups.values()];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order.slice(0, n).map((g) => g[Math.floor(rand() * g.length)]);
}

export const pickedOf = (b: ClassBox): Picked => ({
  uid: b.uid, image_id: b.picture_id ? null : b.image_id, picture_id: b.picture_id ?? null, box: b.box, file_name: b.file_name, group: b.group,
});

/** Ключ рамки на своей картинке. Сервер называет образец по-своему (sha1), а клиенту нужен ключ сразу — и
 *  одинаковый у плитки и у образца набора, чтобы щелчок по рамке находил её в наборе. */
export const pictureKey = (id: string, box: number[]) => `p:${id}:${box.map((v) => Math.round(v * 10) / 10).join(",")}`;

/** Рамки своих картинок плитками, как ручные рамки класса. Каждая рамка — свой предмет: группы
 *  отрицательные, чтобы «Случайно» не путало их с группами кадров проекта. */
export function pictureTiles(pictures: Picture[]): ClassBox[] {
  let group = -1;
  return pictures.flatMap((p) => p.boxes.map((box) => ({
    uid: pictureKey(p.id, box), image_id: "", picture_id: p.id, file_name: p.file_name, dataset: "",
    frame: [p.width, p.height] as [number, number], box, video: null, t: null, group: group--,
  })));
}

/** Образец для сервера: кадр или картинка и рамка. */
export const refOf = (p: Pick<Picked, "image_id" | "picture_id" | "box">): ExampleRef =>
  (p.picture_id ? { picture_id: p.picture_id, box: p.box } : { image_id: p.image_id ?? "", box: p.box });

/** Миниатюра образца: вырезка «авто» с кадра или со своей картинки. */
export const cropUrl = (p: Pick<Picked, "image_id" | "picture_id" | "box">) =>
  (p.picture_id ? pictureCrop(p.picture_id, p.box) : boxCrop(p.image_id ?? "", p.box));

/** Образец набора на руках: у своих картинок ключ — как у плитки. */
export const pickedOfItem = (it: ExampleItem): Picked => ({
  uid: it.picture_id ? pictureKey(it.picture_id, it.box) : it.uid,
  image_id: it.image_id, picture_id: it.picture_id ?? null, box: it.box, file_name: it.file_name,
});

/** Полки — имена классов на картинках человека: открытая первой, дальше по алфавиту, с числом картинок. */
export function shelvesOf(pictures: Picture[], current: string): { name: string; count: number }[] {
  const out = new Map<string, number>();
  out.set(current, 0);
  for (const p of pictures) {
    const name = [...out.keys()].find((n) => sameName(n, p.shelf)) ?? p.shelf;
    out.set(name, (out.get(name) ?? 0) + 1);
  }
  const [first, ...rest] = [...out.entries()].map(([name, count]) => ({ name, count }));
  return [first, ...rest.sort((a, b) => a.name.localeCompare(b.name, "ru"))];
}

/** Картинки полки: имя сравнивается без регистра, как классы. */
export const onShelf = (pictures: Picture[], shelf: string) => pictures.filter((p) => sameName(p.shelf, shelf));

/** Перенести образец с места `from` на место `to`. */
export function moved<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return next;
}

/** Рамка ручной разметки: у многоугольника — охватывающая. */
export function shapeBox(g: { x?: number; y?: number; w?: number; h?: number; parts?: [number, number][][] }):
  [number, number, number, number] | null {
  if (g.parts?.length) {
    const pts = g.parts.flat();
    if (!pts.length) return null;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
  }
  return g.w && g.h ? [g.x ?? 0, g.y ?? 0, g.w, g.h] : null;
}

/** Имена классов сравниваются без регистра, ё = е — как сверка классов при импорте. */
export const sameName = (a: string, b: string) => {
  const norm = (s: string) => s.trim().toLowerCase().replace(/ё/g, "е");
  return norm(a) === norm(b);
};
