// Кадр с рамками агента: выход узла — в цвет класса, отсеянное — серым пунктиром,
// у «Уточнения SAM» контур поверх исходной рамки, разметка человека — белым контуром.

import { useCallback, useRef, useState, type CSSProperties } from "react";
import type { HumanShape, PreviewDet } from "../../api/agents";
import { cx } from "../../ui";

const LABEL_PX = 12;
const ring = (pts: [number, number][]) => pts.map((p) => p.join(",")).join(" ");
const conf = (v: number) => v.toFixed(2).replace(".", ",");

function Det({ d, color, dashed, mark }: { d: PreviewDet; color: string; dashed?: boolean; mark?: string }) {
  const [x, y, w, h] = d.box;
  const style = { stroke: color, strokeDasharray: dashed ? "6 4" : undefined } as CSSProperties;
  return (
    <g>
      {d.parts ? d.parts.map((p, i) => <polygon key={i} points={ring(p)} style={{ ...style, fill: `color-mix(in srgb, ${color} 15%, transparent)` }} />)
        : <rect x={x} y={y} width={w} height={h} style={style} />}
      <text x={x} y={y} style={{ fill: color }}>{`${d.cls} ${conf(d.conf)}${mark ? ` ${mark}` : ""}`}</text>
    </g>
  );
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
  // Ширина кадра на экране — от неё размер подписей в пикселях кадра.
  const [shownW, setShownW] = useState(0);
  const watch = useRef<ResizeObserver | null>(null);
  const box = useCallback((el: HTMLDivElement | null) => {
    watch.current?.disconnect();
    if (!el) return;
    watch.current = new ResizeObserver(([e]) => setShownW(e.contentRect.width));
    watch.current.observe(el);
  }, []);
  const k = shownW ? image.width / shownW : 1;
  return (
    <div ref={box} className={cx("ae-frame", busy && "busy", className)} onDoubleClick={onOpen}
      style={{ "--ar": `${image.width} / ${image.height}`, "--arn": image.width / image.height } as CSSProperties}>
      <img src={`/api/images/${image.id}/file`} alt={image.file_name} draggable={false} />
      <svg viewBox={`0 0 ${image.width} ${image.height}`} preserveAspectRatio="xMidYMid meet"
        // Подпись живёт в пикселях кадра, а читается с экрана: 12 px экрана = 12 × k пикселей кадра.
        style={{ fontSize: LABEL_PX * k, "--halo": `${3 * k}px` } as CSSProperties}>
        {layers.human?.map((s, i) => s.type === "polygon"
          ? (s.geometry.parts ?? []).map((p, j) => <polygon key={`h${i}.${j}`} points={ring(p)} className="ae-human" />)
          : <rect key={`h${i}`} x={s.geometry.x} y={s.geometry.y} width={s.geometry.w} height={s.geometry.h} className="ae-human" />)}
        {layers.dropped?.map((d) => <Det key={`x${d.id}`} d={d} color="var(--faint)" dashed />)}
        {layers.samIn?.map((d) => <Det key={`i${d.id}`} d={{ ...d, parts: undefined }} color={colorOf(d.cls)} dashed />)}
        {layers.out.map((d) => (
          <Det key={d.id} d={d} color={colorOf(d.cls)}
            mark={layers.sam ? (d.parts ? `SAM ${conf(d.sam ?? 0)}` : "SAM не справился") : undefined} />
        ))}
      </svg>
    </div>
  );
}
