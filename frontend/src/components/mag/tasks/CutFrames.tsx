import { useEffect, useId, useState } from "react";
import Pager from "../../Pager";
import type { ReactNode } from "react";
import { getTaskImages, imageThumbUrl } from "../../../auth/api";
import type { TaskImage, TaskImageQuery, TaskVideoItem } from "../../../auth/api";
import type { Tag } from "../../../api/tags";
import { Badge, Button, Card, Check, Empty, Icon, Notice, Popover, Seg, Select, cx } from "../../../ui";
import { count, ru } from "../../ru";
import { fmtTime } from "../VideoCutModal";
import type { SourceCounts } from "./tasks";

export type OpenCutFrame = (image: TaskImage, query: TaskImageQuery) => void;

export function FoldSource({ title, desc, open, onOpen, children, className, id }: {
  title: ReactNode; desc?: ReactNode; open: boolean; onOpen: (open: boolean) => void;
  children: ReactNode; className?: string; id?: string;
}) {
  const bodyId = useId();
  return <Card id={id} className={cx("tp-src tp-fold-source", !open && "is-closed", className)} title={title} desc={desc}
    actions={<Button size="sm" variant="ghost" iconEnd={open ? "chevU" : "chevD"} aria-expanded={open}
      aria-controls={bodyId} onClick={() => onOpen(!open)}>{open ? "Скрыть" : "Показать"}</Button>}>
    <div id={bodyId} className={cx("tp-source-fold", open && "open")} {...(!open ? { inert: "" } : {})}>
      <div><div className="tp-source-body">{children}</div></div>
    </div>
  </Card>;
}

export function FilterTags({ tags, value, onChange }: { tags: Tag[]; value: string[]; onChange: (ids: string[]) => void }) {
  return <Popover align="end" width={260} trigger={<Button size="sm" icon="tag" iconEnd="chevD" disabled={!tags.length}
    aria-label="Фильтр по тагам" title="Любой из выбранных тагов">{value.length ? `Таги: ${value.length}` : "Все таги"}</Button>}>
    {(close) => <div className="tp-filter-tags"><p className="t-xs t-muted">Любой из выбранных тагов</p>
      <div>{tags.map((tag) => <Check key={tag.id} checked={value.includes(tag.id)} onChange={(on) =>
        onChange(on ? [...value, tag.id] : value.filter((id) => id !== tag.id))}>{tag.name}</Check>)}</div>
      <footer><Button size="sm" variant="ghost" disabled={!value.length} onClick={() => onChange([])}>Сбросить</Button>
        <Button size="sm" onClick={close}>Готово</Button></footer>
    </div>}
  </Popover>;
}

const PAGE = 50;
function useFrames(taskId: string, query: TaskImageQuery, enabled: boolean, revision: unknown) {
  const key = JSON.stringify({ taskId, ...query });
  const [position, setPosition] = useState({ key, index: 0 });
  const index = position.key === key ? position.index : 0;
  const requestKey = `${key}:${index}`;
  const blank = { rows: [] as TaskImage[], total: null as number | null,
    counts: null as { new: number; done: number } | null, busy: true, error: null as string | null };
  const [page, setPage] = useState({ key: requestKey, ...blank });
  const [retry, setRetry] = useState(0);
  useEffect(() => { setPosition({ key, index: 0 }); }, [key]);
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    setPage({ key: requestKey, ...blank });
    const { taskId: id, ...params } = JSON.parse(key);
    getTaskImages(id, { ...params, limit: PAGE, offset: index * PAGE }, abort.signal).then((got) => {
      if (abort.signal.aborted) return;
      const last = Math.max(0, Math.ceil(got.matched / PAGE) - 1);
      if (index > last) { setPosition({ key, index: last }); return; }
      setPage({ key: requestKey, rows: got.images, total: got.matched, counts: got.review_counts ?? null, busy: false, error: null });
    }, (e: Error) => {
      if (!abort.signal.aborted) setPage({ key: requestKey, ...blank, busy: false, error: e.message });
    });
    return () => abort.abort();
  }, [key, index, requestKey, enabled, revision, retry]);
  return { ...(page.key === requestKey ? page : blank), index,
    onPage: (next: number) => setPosition({ key, index: next }), retry: () => setRetry((n) => n + 1) };
}

function statusOf(image: TaskImage) {
  if (image.boxes.some((b) => b.pending)) return { text: "Проверить", cls: "agent", icon: "bot" as const };
  if (image.task_status === "empty") return { text: "Фон", cls: "empty", icon: "tick" as const };
  if (image.task_status === "annotated") return { text: "Размечен", cls: "done", icon: "tick" as const };
  if (image.task_status === "skipped") return { text: "Отложен", cls: "skip", icon: "clock" as const };
  return { text: "Не размечен", cls: "new", icon: null };
}

export function CutFramesGallery({ taskId, videos, tags, videoId, open, total, revision, onOpen }: {
  taskId: string; videos: TaskVideoItem[]; tags: Tag[]; videoId?: string; open: boolean; total: number;
  revision: unknown; onOpen: OpenCutFrame;
}) {
  const [source, setSource] = useState("videos"), [selectedTags, setTags] = useState<string[]>([]);
  const [review, setReview] = useState<"all" | "new" | "done">("all"), [view, setView] = useState<"grid" | "list">("grid");
  const chosen = videoId ?? (videos.some((v) => v.id === source && v.frames > 0) ? source : "videos");
  const query: TaskImageQuery = { source: chosen, tag_ids: [...selectedTags].sort(), review };
  const page = useFrames(taskId, query, open && total > 0, revision);
  const filtered = chosen !== (videoId ?? "videos") || selectedTags.length > 0 || review !== "all";
  const reset = () => { setSource("videos"); setTags([]); setReview("all"); };
  const groups = [{ key: "new" as const, label: "Не размечены" }, { key: "done" as const, label: "Размечены" }]
    .map((g) => ({ ...g, rows: page.rows.filter((image) =>
      (statusOf(image).cls === "done" || statusOf(image).cls === "empty") === (g.key === "done")) }));
  const num = (n: number | null) => n == null ? "…" : ru(n);
  return <div className={cx("tp-cut-gallery", total === 0 && "is-empty")} aria-label={videoId ? "Кадры ролика" : "Все нарезанные кадры"}>
    {total > 0 && <div className="tp-cut-toolbar">
      <Seg label="Состояние кадров" value={review} onChange={setReview} size="sm" options={[
        { value: "all", label: <>Все <span className="tp-cut-filter-n">{page.counts ? ru(page.counts.new + page.counts.done) : "…"}</span></> },
        { value: "new", label: <>Не размечены <span className="tp-cut-filter-n">{num(page.counts?.new ?? null)}</span></> },
        { value: "done", label: <>Размечены <span className="tp-cut-filter-n">{num(page.counts?.done ?? null)}</span></> },
      ]} />
      <div className="tp-cut-filters">
        {!videoId && <Select size="sm" label="Фильтр по ролику" value={chosen} onChange={setSource} options={[
          { value: "videos", label: "Все ролики" }, ...videos.filter((v) => v.frames > 0).map((v) => ({ value: v.id, label: v.file_name })),
        ]} />}
        <FilterTags tags={tags} value={selectedTags} onChange={setTags} />
        {filtered && <Button variant="ghost" size="sm" onClick={reset}>Сбросить</Button>}
        <div className="tp-cut-view" role="group" aria-label="Вид кадров">
          <Button size="sm" variant="ghost" icon="grid" aria-label="Плитка" aria-pressed={view === "grid"} onClick={() => setView("grid")} />
          <Button size="sm" variant="ghost" icon="list" aria-label="Список" aria-pressed={view === "list"} onClick={() => setView("list")} />
        </div>
      </div>
    </div>}
    {total === 0 ? <Empty icon="images" title="Кадры появятся после нарезки">Выберите ролик в блоке «Ненарезанные», чтобы нарезать кадры.</Empty>
      : page.total === 0 ? <Empty icon="filter" title={review === "all" ? "Кадров с такими фильтрами нет" : `${review === "new" ? "Не размечены" : "Размечены"}: кадров нет`}
        action={<Button size="sm" onClick={reset}>Сбросить фильтры</Button>} />
        : groups.filter((g) => g.rows.length > 0).map(({ key, label, rows }) => (
            <section key={key} className="tp-cut-frame-group" aria-label={label}>
              <h4>{label}<Badge variant="secondary">{num(page.counts?.[key] ?? null)}</Badge></h4>
              <div className={cx("tp-cut-tiles", view === "list" && "as-list")}>
                {rows.map((image) => {
                  const state = statusOf(image), video = videos.find((v) => v.id === image.source_video_id);
                  return <button key={image.id} className="tp-cut-tile" onClick={() => onOpen(image, query)}
                    aria-label={`${image.file_name}, ${state.text}`}>
                    <span className="tp-cut-picture"><img src={imageThumbUrl(image.id)} alt="" loading="lazy" />
                      <span className="tp-cut-time">{fmtTime(image.source_time_ms ?? 0)}</span>
                      {state.cls === "agent" && <span className="tp-cut-model">Модель</span>}</span>
                    <span className="tp-cut-caption"><span className="t-ell" title={image.file_name}>{image.file_name}</span>
                      <span className={cx("tp-cut-state", state.cls)}>{state.icon && <Icon name={state.icon} size={12} />}{state.text}</span></span>
                    {!videoId && <span className="tp-cut-origin t-ell" title={video?.file_name}>{video?.file_name ?? "Ролик удалён"}</span>}
                  </button>;
                })}
              </div>
            </section>
        ))}
    {total > 0 && <>
      {page.error && <Notice tone="error" action={<Button size="sm" onClick={page.retry}>Повторить</Button>}>{page.error}</Notice>}
      {page.busy && <p className="t-xs t-muted" role="status">Загружаю кадры…</p>}
      {page.total != null && page.total > 0 && <>
        <span className="t-xs t-faint">Кадры {ru(page.index * PAGE + 1)}–{ru(page.index * PAGE + page.rows.length)} из {ru(page.total)}</span>
        <Pager page={page.index} pages={Math.ceil(page.total / PAGE)} onPage={page.onPage} disabled={page.busy} />
      </>}
    </>}
  </div>;
}

export function CutFramesCard({ counts, known, videos, open, onExpand, ...gallery }: {
  counts: SourceCounts; known: boolean; videos: TaskVideoItem[]; open: boolean; onExpand: (open: boolean) => void;
  taskId: string; tags: Tag[]; revision: unknown; onOpen: OpenCutFrame;
}) {
  const total = videos.reduce((n, v) => n + v.frames, 0), done = counts.reviewed ?? (counts.annotated || 0) + (counts.empty || 0);
  return <FoldSource id="task-cut-frames" className={cx("tp-all-cut-frames", total === 0 && "is-empty")}
    open={open} onOpen={onExpand} title={<><Icon name="images" />{total ? "Все нарезанные кадры" : "Нарезанных кадров пока нет"}<Badge variant="secondary">{ru(total)}</Badge></>}
    desc={!total ? "Видео ожидают нарезки" : known ? <><span className="tp-summary-done">{ru(done)} размечено</span><span className="tp-cut-sep">·</span>
      {ru(Math.max(0, total - done))} не размечено<span className="tp-cut-sep">·</span>{count(videos.filter((v) => v.frames > 0).length, "ролик", "ролика", "роликов")}</> : "Считаю состояние разметки…"}>
    <CutFramesGallery {...gallery} videos={videos} open={open} total={total} />
  </FoldSource>;
}
