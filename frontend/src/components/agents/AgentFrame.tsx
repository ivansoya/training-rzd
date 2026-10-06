// Кадр с рамками агента: выход узла — в цвет класса, отсеянное — серым пунктиром,
// у «Уточнения SAM» контур поверх исходной рамки, разметка человека — светлой линией.

import type { CSSProperties } from "react";
import type { HumanShape, PreviewDet } from "../../api/agents";
import { cx } from "../../ui";
import Marks from "../editor/Marks";
import type { Mark } from "../editor/Marks";

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
}

export default function AgentFrame({ image, layers, colorOf, busy, className, onOpen }: {
  image: { id: string; file_name: string; width: number; height: number };
  layers: FrameLayers;
  colorOf: (cls: string) => string;
  busy?: boolean;
  className?: string;
  /** Двойной щелчок — во весь экран. */
  onOpen?: () => void;
}) {
  const items: Mark[] = [
    ...(layers.human ?? []).map((s, i): Mark => {
      const g = s.geometry;
      const parts = s.type === "polygon" ? g.parts : undefined;
      return { key: `h${i}`, x: g.x ?? 0, y: g.y ?? 0, w: g.w ?? 0, h: g.h ?? 0, parts, color: "var(--on-frame)" };
    }),
    ...(layers.dropped ?? []).map((d) => det(d, `x${d.id}`, "var(--faint)", { dashed: true })),
    ...(layers.samIn ?? []).map((d) => det({ ...d, parts: undefined }, `i${d.id}`, colorOf(d.cls), { dashed: true, label: false })),
    ...layers.out.map((d) => det(d, `o${d.id}`, colorOf(d.cls), {
      mark: layers.sam ? (d.parts ? `SAM ${conf(d.sam ?? 0)}` : "SAM не справился") : undefined,
    })),
  ];
  return (
    <div className={cx("ae-frame", busy && "busy", className)} onDoubleClick={onOpen}
      style={{ "--ar": `${image.width} / ${image.height}`, "--arn": image.width / image.height } as CSSProperties}>
      <img src={`/api/images/${image.id}/file`} alt={image.file_name} draggable={false} />
      <Marks width={image.width} height={image.height} items={items} />
    </div>
  );
}
