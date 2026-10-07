// Кадр с рамками агента: выход узла — в цвет класса, отсеянное — серым пунктиром,
// у «Уточнения SAM» контур поверх исходной рамки, разметка человека — светлой линией.
// Со сверкой (`verdict`) выход красится по итогу: верно, ложная, а ручная рамка искомого
// класса, которую узел не нашёл, — пунктиром; разметка классов, что узел не ищет, не рисуется.

import type { CSSProperties, MouseEvent } from "react";
import type { HumanShape, PreviewDet } from "../../api/agents";
import { cx } from "../../ui";
import Marks from "../editor/Marks";
import type { Mark } from "../editor/Marks";
import { shapeBox } from "./examplePick";
import type { Verdict } from "./verdict";

const conf = (v: number) => v.toFixed(2).replace(".", ",");

function det(d: PreviewDet, key: string, color: string, o: { dashed?: boolean; mark?: string; label?: boolean }): Mark {
  const [x, y, w, h] = d.box;
  return {
    key, x, y, w, h, color, parts: d.parts, dashed: o.dashed,
    label: o.label === false ? undefined : (
      <>{d.cls} <span className="mk-num">{conf(d.conf)}</span>{o.mark && <span className="mk-num">{o.mark}</span>}</>
    ),
  };
}

export interface FrameLayers {
  out: PreviewDet[];
  dropped?: PreviewDet[];
  /** Вход «Уточнения SAM» — исходные рамки под контуром. */
  samIn?: PreviewDet[];
  sam?: boolean;
  human?: HumanShape[];
  /** Сверка выхода с ручной разметкой: вместо цветов классов и светлой разметки. */
  verdict?: Verdict;
}

export default function AgentFrame({ image, layers, colorOf, busy, className, onOpen, onHumanMenu }: {
  image: { id: string; file_name: string; width: number; height: number };
  layers: FrameLayers;
  colorOf: (cls: string) => string;
  busy?: boolean;
  className?: string;
  /** Двойной щелчок — во весь экран. */
  onOpen?: () => void;
  /** Правая кнопка по ручной рамке: её форма и где открыть меню. */
  onHumanMenu?: (shape: HumanShape, at: { x: number; y: number }) => void;
}) {
  // Кадр вписан «contain»: точку экрана переводим в пиксели кадра, из рамок под ней берём самую мелкую.
  const v = layers.verdict;
  // Под правую кнопку — ручные рамки, что на кадре есть: со сверкой это рамки искомых классов.
  const pickable = v ? [...v.hit.map((h) => h.human.shape), ...v.missed.map((m) => m.shape)] : layers.human ?? [];
  const menu = (e: MouseEvent<HTMLDivElement>) => {
    if (!onHumanMenu || !pickable.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const k = Math.min(r.width / image.width, r.height / image.height);
    const px = (e.clientX - r.left - (r.width - image.width * k) / 2) / k;
    const py = (e.clientY - r.top - (r.height - image.height * k) / 2) / k;
    const hit = pickable
      .map((s) => ({ s, b: shapeBox(s.geometry) }))
      .filter(({ b }) => b && px >= b[0] && px <= b[0] + b[2] && py >= b[1] && py <= b[1] + b[3])
      .sort((a, b) => a.b![2] * a.b![3] - b.b![2] * b.b![3])[0];
    if (!hit) return;
    e.preventDefault();
    onHumanMenu(hit.s, { x: e.clientX, y: e.clientY });
  };
  const sam = (d: PreviewDet) => (layers.sam ? (d.parts ? `SAM ${conf(d.sam ?? 0)}` : "SAM не справился") : undefined);
  const items: Mark[] = [
    ...(v ? [] : layers.human ?? []).map((s, i): Mark => {
      const g = s.geometry;
      const parts = s.type === "polygon" ? g.parts : undefined;
      return { key: `h${i}`, x: g.x ?? 0, y: g.y ?? 0, w: g.w ?? 0, h: g.h ?? 0, parts, color: "var(--on-frame)" };
    }),
    ...(layers.dropped ?? []).map((d) => det(d, `x${d.id}`, "var(--faint)", { dashed: true })),
    ...(layers.samIn ?? []).map((d) => det({ ...d, parts: undefined }, `i${d.id}`, colorOf(d.cls), { dashed: true, label: false })),
    ...(v ? [
      ...v.missed.map((m, i): Mark => ({
        key: `m${i}`, x: m.box[0], y: m.box[1], w: m.box[2], h: m.box[3], color: "var(--st-skip)", dashed: true,
        parts: m.shape.type === "polygon" ? m.shape.geometry.parts : undefined, label: <>не нашёл · {m.cls}</>,
      })),
      ...v.hit.map(({ det: d }) => det(d, `o${d.id}`, "var(--st-done)", { mark: sam(d) })),
      ...v.wrong.map((d) => det(d, `o${d.id}`, "var(--st-del)", { mark: sam(d) })),
    ] : layers.out.map((d) => det(d, `o${d.id}`, colorOf(d.cls), { mark: sam(d) }))),
  ];
  return (
    <div className={cx("ae-frame", busy && "busy", className)} onDoubleClick={onOpen} onContextMenu={menu}
      style={{ "--ar": `${image.width} / ${image.height}`, "--arn": image.width / image.height } as CSSProperties}>
      <img src={`/api/images/${image.id}/file`} alt={image.file_name} draggable={false} />
      <Marks width={image.width} height={image.height} items={items} />
    </div>
  );
}
