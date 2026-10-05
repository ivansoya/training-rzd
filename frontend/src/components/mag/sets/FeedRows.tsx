// Строки сборки одной половины: «что кладём → через что пропускаем → сколько выйдет».
// Первая строка заводится сама и значит «всё как есть»; убрать её — способ собрать набор из одних ночных кадров.

import { Link } from "react-router-dom";
import type { GraphSummary } from "../../../api/aug";
import type { FeedBinding, FeedPreview, FeedRow } from "../../../api/trainsets";
import type { Tag } from "../../../api/tags";
import { Button, ChipToggle, Icon, Pill, Select } from "../../../ui";
import { mult } from "../../aug/counts";
import { ru } from "../../ru";
import { TRAIN, VAL } from "./sets";

const NONE = "none";

export function FeedRows({ part, rows, graphs, tags, preview, frames, onChange }: {
  part: "train" | "val";
  rows: FeedRow[];
  graphs: GraphSummary[];
  tags: Tag[];
  /** Числа по привязкам — посчитаны сервером тем же кодом, что соберёт. */
  preview: FeedPreview[];
  /** Кадров в половине после деления. */
  frames: number | null;
  onChange: (next: FeedRow[]) => void;
}) {
  const mine = rows.filter((r) => r.part === part);
  const other = rows.filter((r) => r.part !== part);
  const ready = graphs.filter((g) => g.version_id);

  // Источники графа. У версий до 13.09.2026 их в паспорте нет — источник один, безымянный
  const sourcesOf = (versionId: string | null) =>
    (versionId && graphs.find((g) => g.version_id === versionId)?.stats?.sources) || [];
  const put = (next: FeedRow[]) => onChange([...other, ...next.map((r, i) => ({ ...r, position: i }))]);
  const patch = (index: number, change: Partial<FeedRow>) => put(mine.map((r, i) => (i === index ? { ...r, ...change } : r)));

  function pickGraph(index: number, versionId: string | null) {
    const sources = sourcesOf(versionId);
    const row = mine[index];
    // Привязки переносятся на источники нового графа по порядку: «сюда ночные» не стирается
    const keep = (i: number) => ({ feed: row.bindings[i]?.feed ?? part, tag_ids: row.bindings[i]?.tag_ids ?? [] });
    patch(index, {
      graph_version_id: versionId,
      bindings: sources.length ? sources.map((s, i) => ({ source_node: s.id, ...keep(i) })) : [{ source_node: "", ...keep(0) }],
    });
  }
  const setBinding = (r: number, b: number, change: Partial<FeedBinding>) =>
    patch(r, { bindings: mine[r].bindings.map((x, i) => (i === b ? { ...x, ...change } : x)) });
  const numbers = (position: number, node: string) =>
    preview.find((p) => p.part === part && p.position === position && (p.source_node ?? "") === node);

  const total = preview.filter((p) => p.part === part).reduce((a, p) => a + p.samples, 0);
  const graphOptions = [
    { value: NONE, label: "без графа — как есть" },
    ...ready.map((g) => ({ value: g.version_id as string, label: `${g.name} · v${g.version}`, hint: mult(g.stats?.multiplier ?? 1) })),
  ];

  return (
    <section className="ui-card tw-feeds">
      <div className="tw-feeds-h">
        <i style={{ background: part === "train" ? TRAIN : VAL }} />
        <b>{part}</b>
        {frames !== null && <span className="t-sm t-muted">{ru(frames)} кадров</span>}
        <span className="grow" />
        {preview.length > 0 && <span className="t-sm">на выходе <b className="ui-mono">{ru(total)}</b></span>}
      </div>
      {part === "train" && ready.length === 0 && (
        <p className="tw-note">Графов аугментаций пока нет — кадры пойдут как есть. <Link to="/augment">Собрать граф</Link></p>
      )}
      {mine.map((row, index) => {
        const sources = sourcesOf(row.graph_version_id);
        const many = row.bindings.length > 1;
        return (
          <div className="tw-row" key={`${part}-${index}`}>
            {row.bindings.map((b, bi) => {
              const got = numbers(row.position, b.source_node);
              return (
                <div className="tw-line" key={bi}>
                  <span className="tw-no ui-mono">{bi === 0 ? index + 1 : ""}</span>
                  <Select label={`Что кладём в ${part}`} full value={b.feed}
                    onChange={(v) => setBinding(index, bi, { feed: v })} options={[
                      { value: "train", label: "train целиком", hint: part === "val" ? "другая половина" : undefined },
                      { value: "val", label: "val целиком", hint: part === "train" ? "другая половина" : undefined },
                      { value: "tags", label: "кадры с тагами", hint: "любой из выбранных" },
                    ]} />
                  <Icon name="forward" className="tw-ar" />
                  {bi === 0 ? (
                    <Select label="Через что пропускаем" full icon={row.graph_version_id ? "workflow" : undefined}
                      value={row.graph_version_id ?? NONE} onChange={(v) => pickGraph(index, v === NONE ? null : v)}
                      options={graphOptions} />
                  ) : <span className="tw-same">тот же граф{many && sources[bi] ? ` · «${sources[bi].name}»` : ""}</span>}
                  <span className="tw-cnt">
                    {got ? <>{ru(got.images)} → <b>{ru(got.samples)}</b>
                      {got.images > 0 && got.samples !== got.images && <span className="t-faint"> ×{(got.samples / got.images).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}</span>}</> : ""}
                  </span>
                  {bi === 0 ? <Button variant="ghost" size="sm" icon="x" aria-label="Убрать строку" onClick={() => put(mine.filter((_, i) => i !== index))} />
                    : <span />}
                  {many && bi === 0 && sources[0] && <span className="tw-src">источник «{sources[0].name}»</span>}
                  {b.feed === "tags" && (
                    <div className="tw-tags">
                      {tags.length === 0 ? <span className="t-xs t-faint">В проекте нет тагов — их ставят роликам и кадрам.</span>
                        : tags.map((t) => (
                          <ChipToggle key={t.id} pressed={b.tag_ids.includes(t.id)} onToggle={() => setBinding(index, bi, {
                            tag_ids: b.tag_ids.includes(t.id) ? b.tag_ids.filter((x) => x !== t.id) : [...b.tag_ids, t.id],
                          })}>{t.name}</ChipToggle>
                        ))}
                    </div>
                  )}
                  {b.feed !== part && b.feed !== "tags" && (
                    <div className="tw-tags"><Pill tone="warn">Строка кладёт в {part} кадры другой половины — проверка измерит запоминание, а не обобщение.</Pill></div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      {mine.length === 0 && <p className="tw-note warn">Ни одной строки — в {part} не попадёт ни один кадр.</p>}
      <button type="button" className="tw-add" onClick={() => put([...mine, {
        part, position: mine.length, graph_version_id: null, bindings: [{ source_node: "", feed: part, tag_ids: [] }],
      }])}>
        <Icon name="plus" size={14} />{part === "train" ? "Строка: ещё граф или кадры по тагу" : "Строка"}
      </button>
    </section>
  );
}
