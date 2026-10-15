import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { imageThumbUrl } from "../../../auth/api";
import { projectImageIds, projectImages } from "../../../api/gallery";
import type { ImagesQuery, ProjectImage } from "../../../api/gallery";
import type { Tag } from "../../../api/tags";
import { Button, Icon, MenuItem, Popover, cx } from "../../../ui";
import type { IconName } from "../../../ui";
import { count, ru } from "../../ru";
import { DatasetFocus } from "./DatasetFocus";
import { FrameTile } from "./FrameTile";
import type { Overlays, TilePick } from "./FrameTile";
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

/** Отбор кадров в таску (решения 15.10.2026): в одном датасете за раз и как в Фото —
 *  первый выбор включает режим, снят последний — выключает. */
export interface Picking {
  /** Отбор в этом датасете, в другом или нигде. */
  mode: "here" | "away" | "off";
  /** Выбрано в этом датасете, и не видные под отбором тоже. */
  count: number;
  has: (id: string) => boolean;
  set: (ids: string[], on: boolean) => void;
  /** «Включить отбор» пустым или выйти, сняв всё. */
  toggle: () => void;
}

/** Группа галереи: сворачивается, грузит кадры порциями, в DOM держит только видимые ряды. */
export function FrameGroup({ def, code, base, filterKey, ov, tile, collapsed, onCollapse, tags, onTagCreated,
  onEdited, onDataset, canDelete, picking, onError }: {
  def: GroupDef;
  code: string;
  base: ImagesQuery;
  filterKey: string;
  ov: Overlays;
  tile: number;
  collapsed: boolean;
  onCollapse: (v: boolean) => void;
  /** Справочник тагов проекта — для «Фокуса». */
  tags: Tag[];
  onTagCreated: (tag: Tag) => void;
  onEdited: () => void;
  /** Правка датасета группы — только у группировки по датасетам и у редактора. */
  onDataset?: (mode: "rename" | "delete") => void;
  canDelete?: boolean;
  /** Отбор кадров — только у групп-датасетов и у редактора. */
  picking?: Picking;
  onError: (message: string) => void;
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
  // Кадры, ушедшие из датасета, пока открыт «Фокус»: группа перечитается после закрытия
  const [gone, setGone] = useState(0);

  const here = picking?.mode === "here";
  // Пока отбор в другом датасете, здесь флажков нет — щелчок открывает кадр
  const pickable = picking && picking.mode !== "away" ? picking : undefined;

  // Shift-щелчок выбирает от прошлого отмеченного до этого — внутри группы
  const last = useRef<number | null>(null);
  useEffect(() => { if (!here) last.current = null; }, [here]);
  const pickAt = useCallback((i: number, shift: boolean) => {
    if (!picking) return;
    const im = g.items[i];
    if (!im || im.held) return;
    if (shift && last.current !== null) {
      const [a, b] = [Math.min(last.current, i), Math.max(last.current, i)];
      picking.set(g.items.slice(a, b + 1).filter((x) => !x.held).map((x) => x.id), true);
    } else {
      picking.set([im.id], !picking.has(im.id));
    }
    last.current = i;
  }, [picking, g.items]);

  // Флажок группы: при выборе снимает всё, без него выбирает всю группу под отбором,
  // и не подгруженные тоже — их id спрашиваем у сервера
  const free = g.items.filter((x) => !x.held);
  const chosen = here ? free.filter((x) => picking!.has(x.id)).length : 0;
  // Сколько отдал сервер на «выбрать всё»: подгруженных мало, чтобы признать группу выбранной целиком
  const whole = useRef(Infinity);
  const groupState = !here || !picking!.count ? ""
    : chosen === free.length && (rest === 0 || picking!.count >= whole.current) ? "on" : "part";
  const [fetching, setFetching] = useState(false);
  const pickGroup = async () => {
    if (!pickable || fetching) return;
    if (groupState) { pickable.toggle(); return; }
    setFetching(true);
    try {
      const { ids } = await projectImageIds(code, { ...base, ...def.query }, true);
      whole.current = ids.length;
      pickable.set(ids, true);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setFetching(false);
    }
  };

  return (
    <section className={cx("fr-g", collapsed && "col", here && "picking")} id={`fr-g-${def.key}`}>
      <header className="fr-gh">
        {pickable && (
          <button type="button" className={cx("fr-gsel", groupState)} role="checkbox"
            aria-checked={groupState === "on" ? true : groupState ? "mixed" : false} disabled={fetching || total === 0}
            aria-label={groupState ? "Снять весь выбор" : `Выбрать всю группу «${def.title}»`}
            title={groupState ? "Снять весь выбор" : "Выбрать всю группу, включая не показанные"}
            onClick={() => void pickGroup()}><i /></button>
        )}
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
              {picking && (
                <MenuItem icon="check" disabled={!here && total === 0}
                  onSelect={() => { close(); if (!here) onCollapse(false); picking.toggle(); }}>
                  {here ? "Выключить отбор" : "Включить отбор"}
                </MenuItem>
              )}
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
                  onOpen={setViewer} onMore={() => g.more()}
                  pick={pickable ? (i) => ({ on: here && pickable.has(g.items[i].id), active: here,
                    onPick: (shift) => pickAt(i, shift) }) : undefined} />
              )}
        </div>
      </div>
      {viewer !== null && g.items[viewer] && (
        <DatasetFocus title={def.title} items={g.items} index={viewer} total={total - gone} tags={tags}
          onIndex={setViewer}
          onNeedMore={() => g.more()}
          onTagCreated={onTagCreated}
          onClose={() => {
            setViewer(null);
            setGone(0);
            if (edited.current) { edited.current = false; onEdited(); }
          }}
          onPatch={(id, patch) => {
            edited.current = true;
            g.setItems((prev) => prev.map((x) => (x.id === id
              ? { ...x, ...patch, ...(patch.boxes ? { annotations: patch.boxes.length } : {}) } : x)));
          }}
          onRemoved={(id) => {
            edited.current = true;
            setGone((n) => n + 1);
            const left = g.items.filter((x) => x.id !== id);
            g.setItems(left);
            if (!left.length) setViewer(null);
            else setViewer((i) => (i === null ? i : Math.min(i, left.length - 1)));
          }}
        />
      )}
    </section>
  );
}

/** Сетка рядами: высота — за все ряды, отрисованы только попавшие в окно. */
function VirtualGrid({ items, rest, tile, ov, loading, onOpen, onMore, pick }: {
  items: ProjectImage[];
  rest: number;
  tile: number;
  ov: Overlays;
  loading: boolean;
  onOpen: (i: number) => void;
  onMore: () => void;
  pick?: (i: number) => TilePick;
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
              return <FrameTile key={im.id} im={im} ov={ov} onOpen={() => onOpen(i)} pick={pick?.(i)} />;
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
