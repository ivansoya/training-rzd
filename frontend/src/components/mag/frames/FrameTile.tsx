import { memo } from "react";
import type { CSSProperties } from "react";
import { imageThumbUrl } from "../../../auth/api";
import type { ProjectImage } from "../../../api/gallery";
import { count } from "../../ru";
import ShapeMini from "../ShapeMini";
import { FRAME_STATE, frameState } from "./layout";

export interface Overlays {
  boxes: boolean;
  labels: boolean;
  state: boolean;
  split: boolean;
}

/** Плитка кадра: превью, рамки и метки поверх по выбранным тумблерам. */
export const FrameTile = memo(function FrameTile({ im, ov, onOpen }: {
  im: ProjectImage;
  ov: Overlays;
  onOpen: () => void;
}) {
  const st = FRAME_STATE[frameState(im.task_status, im.annotations)];
  const classes = new Map<number, { name: string; color: string; n: number }>();
  if (ov.labels) {
    for (const b of im.boxes) {
      const c = classes.get(b.class_index);
      if (c) c.n += 1;
      else classes.set(b.class_index, { name: b.name, color: b.color, n: 1 });
    }
  }
  return (
    <button type="button" className="fr-tile" onClick={onOpen}
      title={`${im.file_name} — ${count(im.annotations, "объект", "объекта", "объектов")}`}>
      <img src={imageThumbUrl(im.id)} alt="" loading="lazy" decoding="async" draggable={false} />
      {ov.boxes && <ShapeMini boxes={im.boxes} width={im.width} height={im.height} />}
      {ov.split && <span className="fr-split">{im.split === "other" ? "—" : im.split}</span>}
      {ov.state && <span className="fr-state" style={{ "--t": st.color } as CSSProperties} title={st.label} />}
      {ov.labels ? (
        <span className="fr-chips">
          {[...classes.values()].map((c) => (
            <span key={c.name} style={{ "--cc": c.color } as CSSProperties}>
              {c.name}{c.n > 1 ? ` ×${c.n}` : ""}
            </span>
          ))}
        </span>
      ) : (
        <span className="fr-name">{im.file_name.replace(/\.[^.]+$/, "")}</span>
      )}
    </button>
  );
});
