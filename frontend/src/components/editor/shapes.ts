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
