// Один образец собранного набора во весь экран.
//
// Свой, а не общий просмотрщик кадров: тот умеет править разметку и живёт
// номером кадра в базе, а здесь — файл на томе, у которого правки быть не
// может по смыслу. Набор считается неизменным: на нём уже учились, и «поправил
// один кадр» превратило бы прошлые обучения в необъяснимые.
//
// Зато здесь показано то, чего у кадра проекта нет: путь образца по графу и
// какие трансформы к нему применились.

import { useCallback, useEffect } from "react";
import type { Box } from "../../auth/api";
import ShapeMini from "../mag/ShapeMini";

export interface ViewSample {
  name: string;
  split: string;
  objects: number;
  width: number | null;
  height: number | null;
  sid: string;
  ops: string[];
  boxes: Box[];
  src: string;
}

export default function SampleViewer({
  samples,
  index,
  total,
  onIndex,
  onClose,
  onNeedMore,
}: {
  samples: ViewSample[];
  index: number;
  total: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onNeedMore?: () => void;
}) {
  const item = samples[index];

  const step = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next < 0 || next >= samples.length) {
        // На конце показанного просим догрузить: в ленте кадры кончаются
        // раньше, чем набор.
        if (delta > 0 && samples.length < total) onNeedMore?.();
        return;
      }
      onIndex(next);
    },
    [index, samples.length, total, onIndex, onNeedMore]
  );

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose, step]);

  if (!item) return null;

  return (
    <div className="mag-backdrop" onClick={onClose}>
      <div className="s-view" onClick={(e) => e.stopPropagation()}>
        <div className="s-view-top">
          <b>{item.name}</b>
          <span className="s-view-tag">{item.split}</span>
          <span className="s-view-tag">
            {item.objects} {item.objects === 1 ? "объект" : "объектов"}
          </span>
          {item.sid ? (
            <span className="s-view-tag alt" title="Путь образца по графу">
              {item.sid}
            </span>
          ) : (
            <span className="s-view-tag" title="Кадр прошёл мимо аугментаций">
              без аугментаций
            </span>
          )}
          <span className="sp" />
          <span className="s-view-pos">
            {index + 1} из {total.toLocaleString("ru-RU")}
          </span>
          <button type="button" className="mag-ghost mag-ghost-inline" onClick={onClose}>
            Закрыть
          </button>
        </div>

        <div className="s-view-body">
          <button
            type="button"
            className="s-view-arr"
            onClick={() => step(-1)}
            disabled={index === 0}
            aria-label="Предыдущий"
          >
            ‹
          </button>
          <div className="s-view-frame">
            {/* Слой разметки лежит на самой картинке, а не на ячейке.
                Картинка вписана в ячейку и почти всегда у́же неё, а слой,
                растянутый по ячейке, растягивал вместе с собой и рамки: они
                уезжали влево и становились шире кадра. Обёртка ужимается
                ровно по картинке, и слою есть на что лечь. */}
            <span className="s-view-shot">
              <img src={item.src} alt={item.name} />
              {/* Слой по настоящему размеру кадра: картинка здесь вписана
                  целиком, соотношения совпадают, и рамки ложатся точно. */}
              <ShapeMini boxes={item.boxes} width={item.width} height={item.height} />
            </span>
          </div>
          <button
            type="button"
            className="s-view-arr"
            onClick={() => step(1)}
            disabled={index + 1 >= samples.length && samples.length >= total}
            aria-label="Следующий"
          >
            ›
          </button>
        </div>

        {item.ops.length > 0 && (
          <div className="s-view-ops">
            {item.ops.map((op, i) => (
              <span key={i}>{op}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
