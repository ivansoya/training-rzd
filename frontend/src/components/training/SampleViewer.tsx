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
import { useEscape } from "../mag/useEscape";
import { count, ru } from "../ru";
import { useBackdrop } from "../useBackdrop";

const PART: Record<string, string> = { train: "обучение", val: "проверка" };

/** Путь образца по графу словами. `sid` — номера копий через точку
 *  («.0.2» — первая копия первого «Размножения», третья второго), у сетки —
 *  «g<k>». Сырой «.0» на экране ничего не говорил. */
function pathText(sid: string): string {
  return sid
    .split(".")
    .filter(Boolean)
    .map((k) =>
      /^\d+$/.test(k) ? `копия ${Number(k) + 1}` : /^g\d+$/.test(k) ? `сетка ${Number(k.slice(1)) + 1}` : k
    )
    .join(" → ");
}

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
  base = 0,
  names,
  onIndex,
  onClose,
  onNeedMore,
  onEdge,
}: {
  samples: ViewSample[];
  index: number;
  total: number;
  /** Сквозной номер `samples[0]` во всей выборке — для счётчика. */
  base?: number;
  /** Имена трансформов по-русски, из каталога узлов: «Rotate» → «Поворот». */
  names?: Map<string, string>;
  onIndex: (i: number) => void;
  onClose: () => void;
  onNeedMore?: () => void;
  /** Шаг за край загруженной страницы — листать страницу галереи (режим
   *  «Страницы»), как в просмотре кадра датасета. */
  onEdge?: (dir: 1 | -1) => void;
}) {
  const item = samples[index];
  useEscape(onClose);

  const canPrev = index > 0 || (!!onEdge && base > 0);
  const canNext =
    index < samples.length - 1 || base + index < total - 1;

  const step = useCallback(
    (delta: 1 | -1) => {
      const next = index + delta;
      if (next < 0 || next >= samples.length) {
        if (!(delta < 0 ? canPrev : canNext)) return;
        // В страницах листаем страницу, в ленте просим догрузить: кадры
        // показанного кончаются раньше, чем набор.
        if (onEdge) onEdge(delta);
        else if (delta > 0) onNeedMore?.();
        return;
      }
      onIndex(next);
    },
    [index, samples.length, canPrev, canNext, onIndex, onNeedMore, onEdge]
  );

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [step]);

  if (!item) return null;

  return (
    <div className="mag-backdrop" {...useBackdrop(onClose)}>
      <div className="s-view">
        <div className="s-view-top">
          <b>{item.name}</b>
          <span className="s-view-tag">{PART[item.split] ?? item.split}</span>
          <span className="s-view-tag">
            {count(item.objects, "объект", "объекта", "объектов")}
          </span>
          {item.sid ? (
            <span className="s-view-tag alt" title="Путь образца по графу">
              {pathText(item.sid)}
            </span>
          ) : (
            <span className="s-view-tag" title="Кадр прошёл мимо аугментаций">
              без аугментаций
            </span>
          )}
          <span className="sp" />
          <span className="s-view-pos">
            {ru(base + index + 1)} из {ru(total)}
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
            disabled={!canPrev}
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
            disabled={!canNext}
            aria-label="Следующий"
          >
            ›
          </button>
        </div>

        {item.ops.length > 0 && (
          <div className="s-view-ops">
            {item.ops.map((op, i) => (
              <span key={i}>{names?.get(op) ?? op}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
