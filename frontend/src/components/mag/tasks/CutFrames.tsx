import { useEffect, useId, useRef, useState } from "react";
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

const PAGE = 24;
function useFrames(taskId: string, query: TaskImageQuery, enabled: boolean, revision: unknown) {
  const key = JSON.stringify(query);
  const [page, setPage] = useState<{ key: string; rows: TaskImage[]; total: number | null; busy: boolean; error: string | null }>(
    { key, rows: [], total: null, busy: false, error: null });
  const generation = useRef(0), controller = useRef<AbortController | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const token = ++generation.current;
    if (!enabled) return;
    const abort = new AbortController(); controller.current = abort;
    setPage({ key, rows: [], total: null, busy: true, error: null });
    getTaskImages(taskId, { ...JSON.parse(key), limit: PAGE }, abort.signal).then((got) => {
      if (generation.current === token) setPage({ key, rows: got.images, total: got.matched, busy: false, error: null });
    }, (e: Error) => {
      if (!abort.signal.aborted && generation.current === token) setPage({ key, rows: [], total: null, busy: false, error: e.message });
    });
    return () => { ++generation.current; controller.current?.abort(); };
  }, [taskId, key, enabled, revision, retry]);
  const current = page.key === key ? page : { key, rows: [], total: null, busy: true, error: null };
  const more = async () => {
    if (current.busy || controller.current?.signal.aborted || !enabled) return;
    const token = generation.current, abort = new AbortController(); controller.current = abort;
    setPage((p) => ({ ...p, busy: true, error: null }));
    try {
      const got = await getTaskImages(taskId, { ...query, limit: PAGE, offset: current.rows.length }, abort.signal);
      if (generation.current === token) setPage((p) => ({ ...p, rows: [...new Map([...p.rows, ...got.images].map((i) => [i.id, i])).values()],
        total: got.matched, busy: false, error: null }));
    } catch (e) {
      if (!abort.signal.aborted && generation.current === token) setPage((p) => ({ ...p, busy: false, error: (e as Error).message }));
    }
  };
  return { ...current, more, retry: () => setRetry((n) => n + 1) };
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
  const query: TaskImageQuery = { source: chosen, tag_ids: [...selectedTags].sort() };
  const fresh = useFrames(taskId, { ...query, review: "new" }, open && total > 0, revision);
  const ready = useFrames(taskId, { ...query, review: "done" }, open && total > 0, revision);
  const filtered = chosen !== (videoId ?? "videos") || selectedTags.length > 0 || review !== "all";
  const reset = () => { setSource("videos"); setTags([]); setReview("all"); };
  const groups = [{ key: "new" as const, label: "Не размечены", page: fresh }, { key: "done" as const, label: "Размечены", page: ready }];
  const bothEmpty = fresh.total === 0 && ready.total === 0;
  const num = (n: number | null) => n == null ? "…" : ru(n);
  return <div className={cx("tp-cut-gallery", total === 0 && "is-empty")} aria-label={videoId ? "Кадры ролика" : "Все нарезанные кадры"}>
    {total > 0 && <div className="tp-cut-toolbar">
      <Seg label="Состояние кадров" value={review} onChange={setReview} size="sm" options={[
        { value: "all", label: <>Все <span className="tp-cut-filter-n">{fresh.total == null || ready.total == null ? "…" : ru(fresh.total + ready.total)}</span></> },
        { value: "new", label: <>Не размечены <span className="tp-cut-filter-n">{num(fresh.total)}</span></> },
        { value: "done", label: <>Размечены <span className="tp-cut-filter-n">{num(ready.total)}</span></> },
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
      : bothEmpty ? <Empty icon="filter" title="Кадров с такими фильтрами нет" action={<Button size="sm" onClick={reset}>Сбросить фильтры</Button>} />
        : groups.filter((g) => review === "all" || review === g.key).map(({ key, label, page }) => (
          page.total === 0 && !page.error ? review === "all" ? null : <Empty key={key} icon="images" title={`${label}: кадров нет`} />
            : <section key={key} className="tp-cut-frame-group" aria-label={label}>
              <h4>{label}<Badge variant="secondary">{num(page.total)}</Badge></h4>
              {page.error && <Notice tone="error" action={<Button size="sm" onClick={page.retry}>Повторить</Button>}>{page.error}</Notice>}
              <div className={cx("tp-cut-tiles", view === "list" && "as-list")}>
                {page.rows.map((image) => {
                  const state = statusOf(image), video = videos.find((v) => v.id === image.source_video_id);
                  return <button key={image.id} className="tp-cut-tile" onClick={() => onOpen(image, { ...query, ...(review !== "all" ? { review } : {}) })}
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
              {page.busy && <p className="t-xs t-muted" role="status">Загружаю кадры…</p>}
              {page.total != null && page.rows.length < page.total && <Button size="sm" disabled={page.busy} onClick={() => void page.more()}>
                Показать ещё<span className="t-faint">{ru(page.rows.length)} из {ru(page.total)}</span></Button>}
            </section>
        ))}
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
