import { useId, useRef, useState } from "react";
import type { TaskVideoRow } from "../../api/agents";
import type { Tag } from "../../api/tags";
import { Button, Check, Input } from "../../ui";
import Pager from "../Pager";
import Sep from "../Sep";
import { count, ru } from "../ru";
import { FilterTags } from "../mag/tasks/CutFrames";

const PREVIEW = 5;
const PAGE = 20;

export default function RunVideoPicker({ rows, tags, value, onChange }: {
  rows: TaskVideoRow[]; tags: Tag[]; value: Set<string>; onChange: (ids: Set<string>) => void;
}) {
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const needle = query.trim().toLocaleLowerCase("ru");
  const matched = rows.filter((v) => v.file_name.toLocaleLowerCase("ru").includes(needle)
    && (!tagIds.length || tagIds.some((id) => v.tag_ids?.includes(id))));
  const pages = Math.ceil(matched.length / PAGE);
  const index = Math.min(page, Math.max(0, pages - 1));
  const offset = expanded ? index * PAGE : 0;
  const visible = matched.slice(offset, offset + (expanded ? PAGE : PREVIEW));
  const chosen = rows.filter((v) => value.has(v.id)).length;
  const matchedChosen = matched.filter((v) => value.has(v.id)).length;
  const filtered = !!query || tagIds.length > 0;
  const resetPage = () => { setPage(0); listRef.current?.scrollTo(0, 0); };
  const select = (ids: string[], on: boolean) => {
    const next = new Set(value);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    onChange(next);
  };

  return <section className="ar-videos" aria-label="Выбор роликов">
    <div className="ar-video-tools">
      <Input type="search" icon="search" aria-label="Поиск роликов" placeholder="Найти ролик по имени" value={query}
        onChange={(e) => { setQuery(e.target.value); resetPage(); }} />
      <FilterTags tags={tags} value={tagIds} onChange={(ids) => { setTagIds(ids); resetPage(); }} />
      {filtered && <Button size="sm" variant="ghost" onClick={() => { setQuery(""); setTagIds([]); resetPage(); }}>Сбросить</Button>}
    </div>
    <div className="ar-video-summary">
      <span className="t-xs t-muted" role="status">Выбрано {ru(chosen)} из {ru(rows.length)}
        {chosen > matchedChosen && <> · вне фильтра: {ru(chosen - matchedChosen)}</>}</span>
      <Button size="sm" variant="ghost" disabled={!chosen} onClick={() => onChange(new Set())}>Снять выбор</Button>
    </div>
    {matched.length > 0 && <Check checked={matchedChosen === matched.length} indeterminate={matchedChosen > 0 && matchedChosen < matched.length}
      onChange={(on) => select(matched.map((v) => v.id), on)}>Выбрать {filtered ? "найденные" : "все"} ({ru(matched.length)})</Check>}
    <div id={listId} ref={listRef} className="ar-list ar-video-list" tabIndex={expanded && matched.length > PREVIEW ? 0 : undefined}
      role="group" aria-label="Ролики">
      {matched.length === 0 && <p className="t-xs t-faint">{rows.length ? "Ролики не найдены. Измените фильтры." : "Подходящих роликов нет."}</p>}
      {visible.map((v) => <Check key={v.id} checked={value.has(v.id)} onChange={(on) => select([v.id], on)}>
        <span className="ui-mono t-ell" title={v.file_name}>{v.file_name}</span>
        <span className="ar-video-meta t-xs t-faint">{v.frames == null ? "—" : count(v.frames, "кадр", "кадра", "кадров")}<Sep />{v.mode === "cut" ? "нарезка" : "разметка"}</span>
      </Check>)}
    </div>
    {matched.length > PREVIEW && <div className="ar-video-summary">
      <span className="t-xs t-faint">Показаны {ru(offset + 1)}–{ru(offset + visible.length)} из {ru(matched.length)}</span>
      <Button size="sm" variant="ghost" iconEnd={expanded ? "chevU" : "chevD"} aria-expanded={expanded} aria-controls={listId}
        onClick={() => { setExpanded(!expanded); resetPage(); }}>{expanded ? "Свернуть список" : "Раскрыть список"}</Button>
    </div>}
    {expanded && <Pager page={index} pages={pages} onPage={(p) => { setPage(p); listRef.current?.scrollTo(0, 0); }} />}
  </section>;
}
