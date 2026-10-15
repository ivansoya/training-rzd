import { memo } from "react";
import type { CSSProperties } from "react";
import { imageThumbUrl } from "../../../auth/api";
import type { ProjectImage } from "../../../api/gallery";
import { Icon, cx } from "../../../ui";
import { count } from "../../ru";
import ShapeMini from "../ShapeMini";
import { FRAME_STATE, frameState } from "./layout";

export interface Overlays {
  boxes: boolean;
  labels: boolean;
  state: boolean;
  split: boolean;
}

/** Выбор плитки для таски из датасета (решения 14–15.10.2026): флажок — выбор, Shift — диапазон. */
export interface TilePick {
  on: boolean;
  /** Отбор включён в этом датасете: щелчок по всей плитке выбирает, кадр не открывается. */
  active: boolean;
  onPick: (shift: boolean) => void;
}

/** Плитка кадра: превью, рамки и метки поверх по выбранным тумблерам. Щелчок по кадру открывает «Фокус»,
 *  флажок в углу выбирает и включает отбор; кадр с живой копией в таске не выбирается. */
export const FrameTile = memo(function FrameTile({ im, ov, onOpen, pick }: {
  im: ProjectImage;
  ov: Overlays;
  onOpen: () => void;
  pick?: TilePick;
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
  const pending = im.boxes.filter((b) => b.pending).length;
  return (
    <div className={cx("fr-tile", pick && "pick", pick?.on && "on", im.held && "held", pending > 0 && "agent")}
      title={im.held ? `В таске «${im.held.name}» — правится там`
        : `${im.file_name} — ${count(im.annotations, "объект", "объекта", "объектов")}`}>
      <button type="button" className="fr-open" aria-label={im.file_name} aria-pressed={pick?.active ? pick.on : undefined}
        onClick={(e) => (pick?.active ? pick.onPick(e.shiftKey) : onOpen())}>
        <img src={imageThumbUrl(im.id)} alt="" loading="lazy" decoding="async" draggable={false} />
        {ov.boxes && <ShapeMini boxes={im.boxes} width={im.width} height={im.height} />}
      </button>
      {/* Метки — строкой в правом верхнем углу: левый отдан флажку выбора */}
      <span className="fr-tr">
        {pending > 0 && <span className="fr-agt" title={`Агент: ${pending} на проверке`}><Icon name="bot" size={11} />{pending}</span>}
        {ov.split && <span className="fr-split">{im.split === "other" ? "—" : im.split}</span>}
        {ov.state && <span className="fr-state" style={{ "--t": st.color } as CSSProperties} title={st.label} />}
      </span>
      {im.held ? (
        <span className="fr-held"><Icon name="check" size={12} /><span className="t-ell">{im.held.name}</span></span>
      ) : ov.labels ? (
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
      {pick && (
        <button type="button" className="fr-sel" role="checkbox" aria-checked={pick.on} disabled={!!im.held}
          aria-label={im.held ? "Кадр в таске — не выбирается" : "Выбрать кадр"}
          onClick={(e) => pick.onPick(e.shiftKey)}><i /></button>
      )}
    </div>
  );
});
