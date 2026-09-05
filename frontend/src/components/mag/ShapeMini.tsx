/** Что слою нужно от объекта — и ничего сверх того.
 *
 * Не `Box` из api: киноленте класс и имя не нужны, и требовать их значило бы
 * заставлять её носить с собой поля ради чужой сигнатуры. */
export interface MiniShape {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  kind?: "bbox" | "polygon";
  parts?: [number, number][][];
}

/** Разметка на превью: один слой на кинолентy, плитки таски и плитки датасета.
 *
 * Превью — это тоже ответ на вопрос «что здесь размечено», и отвечать он должен
 * тем же, чем редактор. Пока фигура была одна, три места рисовали её тремя
 * наборами `<span>`-ов, и это сходило с рук. Контур прямоугольником не
 * нарисовать вовсе, а нарисованный прямоугольником он врёт: на плитке видно
 * «обведено рамкой» там, где обведено по краю.
 *
 * Отсюда единый слой и одно правило: **бокс — прямоугольник, контур — свои
 * кольца**. На превью различие держится не только формой, но и весом: контур
 * заливается плотнее, потому что на сотне пикселей его форма сама по себе уже
 * не читается, а «это не рамка» читаться обязано.
 *
 * Рисуем в SVG с `viewBox` по размеру кадра: пропорции превью подгоняет
 * `preserveAspectRatio="none"`, ровно как это делают проценты у прежних
 * `<span>`-ов, а толщина линии остаётся экранной (`non-scaling-stroke`).
 *
 * Подписей тут нет намеренно: под `preserveAspectRatio="none"` текст тянется
 * вместе с кадром и на неквадратной плитке становится приплюснутым. Там, где
 * подписи нужны, их кладут обычной вёрсткой поверх.
 */
export default function ShapeMini({
  boxes,
  width,
  height,
}: {
  boxes: MiniShape[];
  width: number | null | undefined;
  height: number | null | undefined;
}) {
  const w = width || 1;
  const h = height || 1;
  if (!boxes.length) return null;

  return (
    <svg
      className="mag-shp"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {boxes.map((b, i) =>
        b.kind === "polygon" && b.parts?.length ? (
          <path
            key={i}
            className="mag-shp-poly"
            style={{ ["--bc" as string]: b.color }}
            d={b.parts
              .filter((ring) => ring.length > 2)
              .map(
                (ring) =>
                  "M" + ring.map(([x, y]) => `${x} ${y}`).join("L") + "Z"
              )
              .join("")}
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          <rect
            key={i}
            className="mag-shp-box"
            style={{ ["--bc" as string]: b.color }}
            x={b.x}
            y={b.y}
            width={Math.max(b.w, 0)}
            height={Math.max(b.h, 0)}
            vectorEffect="non-scaling-stroke"
          />
        )
      )}
    </svg>
  );
}
