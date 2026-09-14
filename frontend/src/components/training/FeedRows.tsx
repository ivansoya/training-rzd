import type { GraphSummary } from "../../api/aug";
import type { FeedBinding, FeedPreview, FeedRow } from "../../api/trainsets";
import type { Tag } from "../../api/tags";

/**
 * Строки сборки одной половины набора: «что кладём → через что пропускаем».
 *
 * До 13.09.2026 здесь стояли две выпадашки — граф на обучение и граф на
 * проверку. Этого не хватило: на половину вешают несколько графов, у графа
 * бывает несколько «Источников», и каждому говорят, откуда брать кадры —
 * из половины целиком или по тагам.
 *
 * Строка рисуется одной линией, потому что читается она как предложение:
 * номер, что кладём, стрелка, через что, числа. Разложенная на три этажа
 * (так было в первом заходе), она превращалась в форму с полями, и связь
 * «это льётся вот сюда» из неё пропадала.
 *
 * Первая строка заводится сама и означает «всё как есть». Её можно изменить
 * или убрать — тогда набор окажется МЕНЬШЕ своей половины, и это не ошибка, а
 * способ собрать набор из одних ночных кадров.
 */
export default function FeedRows({
  part,
  rows,
  graphs,
  tags,
  preview,
  onChange,
}: {
  part: "train" | "val";
  rows: FeedRow[];
  graphs: GraphSummary[];
  tags: Tag[];
  /** Числа по привязкам — то, что посчитал сервер тем же кодом, что соберёт. */
  preview: FeedPreview[];
  onChange: (next: FeedRow[]) => void;
}) {
  const mine = rows.filter((r) => r.part === part);
  const other = rows.filter((r) => r.part !== part);
  const here = part === "train" ? "обучение" : "проверку";

  /** Источники выбранного графа. У версий до 13.09.2026 их в паспорте нет —
   *  там источник ровно один, безымянный, и привязка к нему одна. */
  const sourcesOf = (versionId: string | null) =>
    (versionId && graphs.find((g) => g.version_id === versionId)?.stats?.sources) || [];

  const put = (next: FeedRow[]) =>
    onChange([...other, ...next.map((r, i) => ({ ...r, position: i }))]);

  const patch = (index: number, change: Partial<FeedRow>) =>
    put(mine.map((r, i) => (i === index ? { ...r, ...change } : r)));

  function pickGraph(index: number, versionId: string) {
    const sources = sourcesOf(versionId || null);
    const row = mine[index];
    // Привязки перекладываем на источники нового графа по порядку: человек
    // уже сказал «сюда ночные», и стирать это при смене графа обидно.
    const keep = (i: number) => ({
      feed: row.bindings[i]?.feed ?? part,
      tag_ids: row.bindings[i]?.tag_ids ?? [],
    });
    patch(index, {
      graph_version_id: versionId || null,
      bindings: sources.length
        ? sources.map((s, i) => ({ source_node: s.id, ...keep(i) }))
        : [{ source_node: "", ...keep(0) }],
    });
  }

  const setBinding = (
    rowIndex: number,
    bIndex: number,
    change: Partial<FeedBinding>
  ) =>
    patch(rowIndex, {
      bindings: mine[rowIndex].bindings.map((b, i) =>
        i === bIndex ? { ...b, ...change } : b
      ),
    });

  const numbers = (position: number, sourceNode: string) =>
    preview.find(
      (p) =>
        p.part === part &&
        p.position === position &&
        (p.source_node ?? "") === sourceNode
    );

  return (
    <div className="t-feeds">
      {mine.map((row, index) => {
        const sources = sourcesOf(row.graph_version_id);
        const many = row.bindings.length > 1;
        return (
          <div className="t-feed" key={`${part}-${index}`}>
            {row.bindings.map((binding, bIndex) => {
              const got = numbers(row.position, binding.source_node);
              return (
                <div className="t-feed-line" key={bIndex}>
                  {/* Номер строки — только у первой привязки: остальные
                      относятся к той же строке и к тому же графу. */}
                  <span className="t-feed-n">{bIndex === 0 ? index + 1 : ""}</span>

                  <select
                    className="t-feed-what"
                    value={binding.feed}
                    aria-label={`что кладём в ${here}`}
                    onChange={(e) =>
                      setBinding(index, bIndex, {
                        feed: e.target.value as FeedBinding["feed"],
                      })
                    }
                  >
                    <option value="train">обучающую половину</option>
                    <option value="val">проверочную половину</option>
                    <option value="tags">кадры с тагами</option>
                  </select>

                  <span className="t-feed-arrow" aria-hidden="true">→</span>

                  {/* Граф выбирают один раз на строку: у второй и дальше
                      привязок вместо выпадашки стоит имя источника. */}
                  {bIndex === 0 ? (
                    <select
                      className="t-feed-graph"
                      value={row.graph_version_id ?? ""}
                      aria-label="через что пропускаем"
                      onChange={(e) => pickGraph(index, e.target.value)}
                    >
                      <option value="">без графа — как есть</option>
                      {graphs
                        .filter((g) => g.version_id)
                        .map((g) => (
                          <option key={g.id} value={g.version_id as string}>
                            {g.name} · в{g.version} · ×{g.stats?.multiplier ?? 1}
                          </option>
                        ))}
                    </select>
                  ) : (
                    <span className="t-feed-graph t-feed-same">
                      тот же граф
                    </span>
                  )}

                  {many && (
                    <span className="t-feed-src" title="источник графа">
                      {sources[bIndex]?.name ?? "источник"}
                    </span>
                  )}

                  <span className="t-feed-num">
                    {got
                      ? `${got.images.toLocaleString("ru-RU")} → ${got.samples.toLocaleString("ru-RU")}`
                      : ""}
                  </span>

                  {bIndex === 0 ? (
                    <button
                      type="button"
                      className="t-feed-x"
                      aria-label="убрать строку"
                      onClick={() => put(mine.filter((_, i) => i !== index))}
                    >
                      ✕
                    </button>
                  ) : (
                    <span className="t-feed-x" />
                  )}

                  {binding.feed === "tags" && (
                    <div className="t-feed-tags">
                      {tags.length === 0 ? (
                        <span className="t-feed-note">
                          В проекте нет тагов — их ставят роликам и кадрам.
                        </span>
                      ) : (
                        tags.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            className={`t-chip${
                              binding.tag_ids.includes(t.id) ? " on" : ""
                            }`}
                            onClick={() =>
                              setBinding(index, bIndex, {
                                tag_ids: binding.tag_ids.includes(t.id)
                                  ? binding.tag_ids.filter((x) => x !== t.id)
                                  : [...binding.tag_ids, t.id],
                              })
                            }
                          >
                            {t.name}
                          </button>
                        ))
                      )}
                    </div>
                  )}

                  {binding.feed !== part && binding.feed !== "tags" && (
                    <div className="t-feed-warn">
                      Строка кладёт в {here} кадры другой половины. Проверка
                      после такого мерит запоминание, а не обобщение.
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      <button
        type="button"
        className="t-feed-add"
        onClick={() =>
          put([
            ...mine,
            {
              part,
              position: mine.length,
              graph_version_id: null,
              bindings: [{ source_node: "", feed: part, tag_ids: [] }],
            },
          ])
        }
      >
        + строка
      </button>

      {mine.length === 0 && (
        <p className="t-feed-warn">
          Ни одной строки — в {here} не попадёт ни один кадр.
        </p>
      )}
    </div>
  );
}
