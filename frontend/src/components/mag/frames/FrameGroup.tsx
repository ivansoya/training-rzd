import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { imageThumbUrl } from "../../../auth/api";
import type { LabelClass } from "../../../auth/api";
import { projectImages } from "../../../api/gallery";
import type { ImagesQuery, ProjectImage } from "../../../api/gallery";
import { Button, Icon, MenuItem, Popover, cx } from "../../../ui";
import type { IconName } from "../../../ui";
import { count, ru } from "../../ru";
import ImageViewer from "../ImageViewer";
import { FrameTile } from "./FrameTile";
import type { Overlays } from "./FrameTile";
import { GAP, gridLayout, visibleRows } from "./layout";
import { MORE, useGroupFrames } from "./useGroupFrames";

export interface GroupDef {
  key: string;
  title: string;
  icon: IconName;
  /** Кадров группы под текущим отбором — из сводки. */
  matched: number;
  /** Чем группа сужает общий отбор. */
  query: Partial<ImagesQuery>;
  dataset?: { id: string; name: string };
}

/** Группа галереи: сворачивается, грузит кадры порциями, в DOM держит только видимые ряды. */
export function FrameGroup({ def, code, base, filterKey, ov, tile, collapsed, onCollapse, classes, canEdit,
  onEdited, onDataset, canDelete }: {
  def: GroupDef;
  code: string;
  base: ImagesQuery;
  filterKey: string;
  ov: Overlays;
  tile: number;
  collapsed: boolean;
  onCollapse: (v: boolean) => void;
  classes: LabelClass[];
  canEdit: boolean;
  onEdited: () => void;
  /** Правка датасета группы — только у группировки по датасетам и у редактора. */
  onDataset?: (mode: "rename" | "delete") => void;
  canDelete?: boolean;
}) {
  const load = useCallback(async (offset: number, limit: number) => {
    const got = await projectImages(code, { ...base, ...def.query, offset, limit });
    return { items: got.images, matched: got.matched };
  }, [code, base, def.query]);
  const g = useGroupFrames<ProjectImage>(load, `${filterKey}|${def.key}`);
  const total = g.matched ?? def.matched;
  const rest = total - g.items.length;

  const [viewer, setViewer] = useState<number | null>(null);
  const edited = useRef(false);

  return (
    <section className={cx("fr-g", collapsed && "col")} id={`fr-g-${def.key}`}>
      <header className="fr-gh">
        <button type="button" className="fr-gt" aria-expanded={!collapsed} onClick={() => onCollapse(!collapsed)}>
          <Icon name="chevD" className="fr-chev" />
          <Icon name={def.icon} />
          <b className="t-ell">{def.title}</b>
          <span className="ui-mono t-xs t-muted">{count(total, "кадр", "кадра", "кадров")}</span>
        </button>
        <span className="fr-peek" aria-hidden="true">
          {g.items.slice(0, 5).map((im) => <img key={im.id} src={imageThumbUrl(im.id)} alt="" loading="lazy" />)}
        </span>
        <span className="grow" />
        {g.loading && <span className="t-xs t-faint">загружаю…</span>}
        <Popover align="end" trigger={<Button variant="ghost" size="sm" icon="more" aria-label="Действия с группой" />}>
          {(close) => (
            <>
              <MenuItem icon="images" disabled={rest <= 0} onSelect={() => { close(); onCollapse(false); g.all(); }}
                hint={rest > 0 ? `ещё ${count(rest, "кадр", "кадра", "кадров")}` : "все уже показаны"}>
                Показать все
              </MenuItem>
              {onDataset && (
                <MenuItem icon="edit" onSelect={() => { close(); onDataset("rename"); }}>Переименовать…</MenuItem>
              )}
              {onDataset && canDelete && (
                <MenuItem icon="trash" danger onSelect={() => { close(); onDataset("delete"); }}>Удалить датасет…</MenuItem>
              )}
            </>
          )}
        </Popover>
      </header>
      <div className="fr-body">
        <div className="fr-in">
          {g.error ? <p className="fr-note err">{g.error}</p>
            : total === 0 ? <p className="fr-note">Под отбор не подошёл ни один кадр группы.</p>
              : (
                <VirtualGrid items={g.items} rest={rest} tile={tile} ov={ov} loading={g.loading}
                  onOpen={setViewer} onMore={() => g.more()} />
              )}
        </div>
      </div>
      {viewer !== null && g.items[viewer] && createPortal(
        <ImageViewer
          images={g.items}
          index={viewer}
          total={total}
          classes={classes}
          canEdit={canEdit}
          onIndex={setViewer}
          onNeedMore={() => g.more()}
          onClose={() => {
            setViewer(null);
            if (edited.current) { edited.current = false; onEdited(); }
          }}
          onSaved={(updated) => {
            edited.current = true;
            g.setItems((prev) => prev.map((x) => (x.id === updated.id ? { ...x, ...updated } : x)));
          }}
        />,
        document.body,
      )}
    </section>
  );
}

/** Сетка рядами: высота — за все ряды, отрисованы только попавшие в окно. */
function VirtualGrid({ items, rest, tile, ov, loading, onOpen, onMore }: {
  items: ProjectImage[];
  rest: number;
  tile: number;
  ov: Overlays;
  loading: boolean;
  onOpen: (i: number) => void;
  onMore: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, 0]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const lay = gridLayout(width || 1, tile, GAP);
  const cells = items.length + (rest > 0 ? 1 : 0);
  const rows = Math.ceil(cells / lay.cols);

  useEffect(() => {
    const el = box.current;
    if (!el || !width) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const top = el.getBoundingClientRect().top;
      const next = visibleRows(top, window.innerHeight, lay.stride, rows);
      setRange((cur) => (cur[0] === next[0] && cur[1] === next[1] ? cur : next));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [width, lay.stride, rows]);

  const [r0, r1] = range;
  const from = r0 * lay.cols;
  const to = Math.min(cells, r1 * lay.cols);
  const height = rows ? rows * lay.stride - GAP : 0;

  return (
    <div ref={box} className="fr-grid-box" style={{ height }}>
      {width > 0 && (
        <div className="fr-grid" style={{
          transform: `translateY(${r0 * lay.stride}px)`,
          gridTemplateColumns: `repeat(${lay.cols}, minmax(0, 1fr))`,
          gridAutoRows: `${lay.rowH}px`,
          gap: GAP,
        }}>
          {Array.from({ length: Math.max(0, to - from) }, (_, k) => {
            const i = from + k;
            if (i < items.length) {
              const im = items[i];
              return <FrameTile key={im.id} im={im} ov={ov} onOpen={() => onOpen(i)} />;
            }
            return (
              <button key="more" type="button" className="fr-tile fr-more" disabled={loading} onClick={onMore}
                title={`Показать ещё ${ru(Math.min(MORE, rest))} из ${ru(rest)}`}>
                {items.length > 0 && <img src={imageThumbUrl(items[items.length - 1].id)} alt="" loading="lazy" />}
                <span className="fr-more-in">
                  <b className="ui-mono">+{ru(rest)}</b>
                  <span>{loading ? "загружаю…" : "показать ещё"}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
