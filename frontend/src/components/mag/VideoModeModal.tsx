import { useState } from "react";
import type { VideoMode } from "../../auth/api";
import { useEscape } from "./useEscape";

/** Выбор того, что делать с роликом. Спрашиваем один раз — при загрузке.
 *
 *  Режим потом не меняется, и это не упрощение ради экономии: от него зависит,
 *  где живёт разметка. У нарезки кадры существуют сразу и размечаются как
 *  картинки; у разметки видео кадры появляются только на сдаче таски. Смена
 *  режима на полпути означала бы переписать уже сделанную работу.
 */
export default function VideoModeModal({
  fileName,
  onPick,
  onClose,
}: {
  fileName: string;
  onPick: (mode: VideoMode) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<VideoMode>("cut");
  useEscape(onClose);

  return (
    <div className="mag-backdrop" onClick={onClose}>
      <div
        className="mag-modal mag-vmode"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Что делать с видео"
      >
        <h1>Что делать с видео</h1>
        <p className="mag-sub">{fileName}</p>

        <div className="mag-vmode-picks">
          <label className={mode === "cut" ? "mag-vmode-pick on" : "mag-vmode-pick"}>
            <input
              type="radio"
              name="video-mode"
              checked={mode === "cut"}
              onChange={() => setMode("cut")}
            />
            <span className="mag-vmode-body">
              <b>Нарезать на кадры</b>
              <span>
                Выбираете участки на дорожке, из них получаются отдельные кадры.
                Размечаются они как обычные изображения.
              </span>
            </span>
          </label>

          <label className={mode === "annotate" ? "mag-vmode-pick on" : "mag-vmode-pick"}>
            <input
              type="radio"
              name="video-mode"
              checked={mode === "annotate"}
              onChange={() => setMode("annotate")}
            />
            <span className="mag-vmode-body">
              <b>Размечать видео</b>
              <span>
                Размечаете ролик покадрово. Объект можно вести треком: поставили
                на одном кадре, убрали на другом, между ними положение считается.
                Размеченные кадры уйдут в проект, когда сдадите таску.
              </span>
            </span>
          </label>
        </div>

        <p className="mag-vmode-warn">
          Режим закрепляется за роликом навсегда. Нужен другой — загрузите видео
          второй раз.
        </p>

        <div className="mag-modal-foot">
          <button className="mag-ghost mag-ghost-inline" type="button" onClick={onClose}>
            Отмена
          </button>
          <button
            className="mag-btn mag-btn-inline"
            type="button"
            onClick={() => onPick(mode)}
          >
            {mode === "cut" ? "Загрузить для нарезки" : "Загрузить для разметки"}
          </button>
        </div>
      </div>
    </div>
  );
}
