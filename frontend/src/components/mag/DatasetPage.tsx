// Датасет: паспорт и его кадры.
//
// Живёт вкладкой проекта, а не отдельной страницей. Раньше маршрут стоял рядом
// с проектом, а не внутри него, и на этой странице пропадали обе строки
// навигации — и разделы проекта, и его паспорт: уйти отсюда в «Классы» было
// некуда, кроме как через «назад» браузера.
//
// Сетка кадров, фильтры и режим вывода — общие с «Все кадры» и просмотром
// собранного набора: `Gallery` плюс `useGallery`.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getClasses, getDataset, imageThumbUrl } from "../../auth/api";
import type { DatasetImage, DatasetStats, LabelClass } from "../../auth/api";
import ClassPicker from "./ClassPicker";
import Gallery from "./Gallery";
import type { GalleryItem } from "./Gallery";
import ImageViewer from "./ImageViewer";
import { plural } from "./ProjectsPage";
import { useGallery } from "./useGallery";
import type { Mode } from "./useGallery";

const SPLITS = [
  { value: "", label: "Все части" },
  { value: "train", label: "train" },
  { value: "val", label: "val" },
  { value: "test", label: "test" },
  { value: "other", label: "Вне частей" },
];

export default function DatasetPage() {
  const { code, datasetId } = useParams<{ code: string; datasetId: string }>();

  const [name, setName] = useState("");
  const [stats, setStats] = useState<DatasetStats | null>(null);
  const [role, setRole] = useState("viewer");
  const [classes, setClasses] = useState<LabelClass[]>([]);

  const [split, setSplit] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  const [sort, setSort] = useState<"name" | "objects">("name");

  const [size, setSize] = useState("m");
  const [mode, setMode] = useState<Mode>("pages");
  const [showBoxes, setShowBoxes] = useState(true);
  const [viewer, setViewer] = useState<number | null>(null);

  useEffect(() => {
    if (code) getClasses(code).then((c) => setClasses(c.classes)).catch(() => {});
  }, [code]);

  const load = useCallback(
    async (offset: number, limit: number) => {
      if (!code || !datasetId) return { items: [] as DatasetImage[], matched: 0 };
      const got = await getDataset(code, datasetId, {
        split: split || undefined,
        classes: picked,
        empty: onlyEmpty,
        sort,
        limit,
        offset,
      });
      setName(got.dataset.name);
      setStats(got.stats);
      setRole(got.my_role);
      return { items: got.images, matched: got.matched };
    },
    [code, datasetId, split, picked, onlyEmpty, sort]
  );

  const g = useGallery<DatasetImage>(load, mode);

  const tiles = useMemo<GalleryItem[]>(
    () =>
      g.items.map((im) => ({
        key: im.id,
        thumb: imageThumbUrl(im.id),
        title: im.file_name,
        split: im.split,
        objects: im.annotations,
        width: im.width,
        height: im.height,
        boxes: im.boxes,
      })),
    [g.items]
  );

  if (g.error && !stats) {
    return (
      <div className="mag-card">
        <div className="mag-error">{g.error}</div>
        <Link to={`/projects/${code}/datasets`} className="mag-link">
          ← К датасетам
        </Link>
      </div>
    );
  }
  if (!stats) return <div className="mag-empty">Загружаем датасет…</div>;

  const res = stats.resolutions[0];
  const uniform = stats.resolutions.length === 1;

  return (
    <>
      <div className="mag-card">
        <div className="mag-card-h">
          <h4>{name}</h4>
          <Link className="mag-ghost mag-ghost-inline" to={`/projects/${code}/datasets`}>
            Все датасеты
          </Link>
        </div>
        <div className="mag-statrow mag-ds-stats">
          <div className="mag-stat">
            <b>{stats.images.toLocaleString("ru-RU")}</b>
            <span>{plural(stats.images, "изображение", "изображения", "изображений")}</span>
          </div>
          <div className="mag-stat">
            <b>{stats.annotations.toLocaleString("ru-RU")}</b>
            <span>разметок</span>
          </div>
          <div className="mag-stat">
            <b>{stats.per_image.toLocaleString("ru-RU")}</b>
            <span>объектов на кадр</span>
          </div>
          <div className={stats.without_annotations ? "mag-stat warn" : "mag-stat"}>
            <b>{stats.without_annotations.toLocaleString("ru-RU")}</b>
            <span>кадров без разметки</span>
          </div>
          {["train", "val", "test", "other"]
            .filter((s) => stats.splits[s])
            .map((s) => (
              <div className="mag-stat" key={s}>
                <b>{stats.splits[s].toLocaleString("ru-RU")}</b>
                <span>{s === "other" ? "вне частей" : s}</span>
              </div>
            ))}
          <div className={uniform ? "mag-stat" : "mag-stat warn"}>
            <b>{res ? `${res.width}×${res.height}` : "—"}</b>
            <span>{uniform ? "все кадры" : "и ещё размеры"}</span>
          </div>
        </div>
      </div>

      <div className="mag-card">
        <Gallery
          items={tiles}
          matched={g.matched}
          total={stats.images}
          loading={g.loading}
          error={g.error}
          mode={mode}
          onMode={setMode}
          size={size}
          onSize={setSize}
          boxes={showBoxes}
          onBoxes={setShowBoxes}
          page={g.page}
          pages={g.pages}
          onPage={g.goto}
          onMore={g.more}
          onOpen={setViewer}
          filters={
            <>
              <select
                value={split}
                aria-label="Часть набора"
                onChange={(e) => setSplit(e.target.value)}
              >
                {SPLITS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>

              <ClassPicker
                classes={classes.map((c) => ({
                  class_index: c.class_index,
                  name: c.name,
                  color: c.color,
                  count: c.annotations,
                }))}
                picked={picked}
                onChange={setPicked}
              />

              <button
                type="button"
                className={
                  onlyEmpty
                    ? "mag-ghost mag-ghost-inline on"
                    : "mag-ghost mag-ghost-inline"
                }
                onClick={() => setOnlyEmpty((v) => !v)}
              >
                Только без разметки
              </button>

              <select
                value={sort}
                aria-label="Сортировка"
                onChange={(e) => setSort(e.target.value as "name" | "objects")}
              >
                <option value="name">По имени</option>
                <option value="objects">По числу объектов</option>
              </select>
            </>
          }
        />
      </div>

      {viewer !== null && g.items[viewer] && (
        <ImageViewer
          images={g.items}
          index={viewer}
          total={g.matched}
          classes={classes}
          canEdit={role === "admin" || role === "editor"}
          onIndex={setViewer}
          onClose={() => setViewer(null)}
          onNeedMore={mode === "feed" ? g.more : undefined}
          onSaved={(updated) =>
            g.setItems((prev) =>
              prev.map((x) => (x.id === updated.id ? updated : x))
            )
          }
        />
      )}
    </>
  );
}
