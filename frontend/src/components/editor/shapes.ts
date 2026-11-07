import type { CanvasShape } from "../mag/BoxCanvas";
import { bounds, removePart } from "../mag/polygon";

/** Вынести часть в самостоятельный объект; исходный сохраняет свой id. */
export function detachContour(shapes: CanvasShape[], index: number, part: number): CanvasShape[] {
  const shape = shapes[index];
  const rings = shape?.parts;
  const ring = rings?.[part];
  if (!rings || !ring || rings.length < 2) return shapes;
  const parts = removePart(rings, part);
  const rest = bounds(parts);
  const detached = bounds([ring]);
  if (!rest || !detached) return shapes;
  return [
    ...shapes.map((s, i) => i === index ? { ...s, parts, ...rest, pending: false } : s),
    { class_index: shape.class_index, kind: "polygon", parts: [ring], ...detached, source: "human" },
  ];
}

/** Несколько объектов одного класса становятся одним объектом с прежними контурами. */
export function mergeContours(shapes: CanvasShape[], indices: ReadonlySet<number>, anchor: number): CanvasShape[] {
  const keep = shapes[anchor];
  if (indices.size < 2 || !indices.has(anchor) || !keep?.parts?.length) return shapes;
  const picked = [...indices].sort((a, b) => a - b);
  if (picked.some((i) => !shapes[i]?.parts?.length || shapes[i].class_index !== keep.class_index)) return shapes;
  const parts = picked.flatMap((i) => shapes[i].parts!);
  const box = bounds(parts);
  if (!box) return shapes;
  return shapes.flatMap((shape, i) => i === anchor
    ? [{ ...keep, kind: "polygon" as const, parts, ...box, pending: false }]
    : indices.has(i) ? [] : [shape]);
}

/** Ctrl+клик меняет выбор только среди полигонов одного класса. */
export function togglePolygonSelection(shapes: CanvasShape[], selected: number | null, group: ReadonlySet<number>, index: number):
  { selected: number | null; group: Set<number> } | null {
  const target = shapes[index];
  if (!target?.parts?.length) return null;
  const current = selected === null ? undefined : shapes[selected];
  if (!current?.parts?.length) return { selected: index, group: new Set() };
  if (target.class_index !== current.class_index) return null;
  const next = new Set(group.size ? group : [selected!]);
  if (next.has(index)) next.delete(index); else next.add(index);
  if (next.size <= 1) return { selected: next.values().next().value ?? null, group: new Set() };
  return { selected: next.has(selected!) ? selected : next.values().next().value!, group: next };
}
