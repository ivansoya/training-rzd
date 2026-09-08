// Все кадры проекта разом — вкладкой в обзоре.
//
// Датасетов в проекте бывает несколько, и вопрос «как размечен этот класс»
// почти никогда не про один из них. Раньше ответ собирался руками: открыть
// первый датасет, отфильтровать, запомнить, открыть второй. Здесь кадры всех
// датасетов лежат в одной сетке, а на плитке написано, из какого она.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { getClasses, imageThumbUrl } from "../../auth/api";
import type { LabelClass } from "../../auth/api";
import * as gallery from "../../api/gallery";
import type { ProjectImage } from "../../api/gallery";
import ClassPicker from "./ClassPicker";
import Gallery from "./Gallery";
import type { GalleryItem } from "./Gallery";
import ImageViewer from "./ImageViewer";
import { useGallery } from "./useGallery";
import type { Mode } from "./useGallery";

const SPLITS = [
  { value: "", label: "Все части" },
  { value: "train", label: "train" },
  { value: "val", label: "val" },
  { value: "test", label: "test" },
  { value: "other", label: "Вне частей" },
];

export default function ProjectGallery({
  datasets,
  role,
}: {
  datasets: { id: string; name: string }[];
  role: string;
}) {
  const { code } = useParams<{ code: string }>();

  // Классы берём свои, а не из паспорта проекта: просмотрщику нужен полный
  // класс с номером в базе — он умеет править разметку прямо из кадра.
  const [classes, setClasses] = useState<LabelClass[]>([]);
  useEffect(() => {
    if (code) getClasses(code).then((c) => setClasses(c.classes)).catch(() => {});
  }, [code]);

  const [chosen, setChosen] = useState<string[]>([]);
  const [split, setSplit] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  const [sort, setSort] = useState<"name" | "objects">("name");

  const [size, setSize] = useState("m");
  const [mode, setMode] = useState<Mode>("pages");
  const [showBoxes, setShowBoxes] = useState(true);
  const [viewer, setViewer] = useState<number | null>(null);
  const [total, setTotal] = useState<number | undefined>(undefined);

  const load = useCallback(
    async (offset: number, limit: number) => {
      if (!code) return { items: [] as ProjectImage[], matched: 0 };
      const got = await gallery.projectImages(code, {
        datasets: chosen,
        classes: picked,
        split: split || undefined,
        empty: onlyEmpty,
        sort,
        limit,
        offset,
      });
      setTotal(got.total);
      return { items: got.images, matched: got.matched };
    },
    [code, chosen, picked, split, onlyEmpty, sort]
  );

  const g = useGallery<ProjectImage>(load, mode);

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
        // Из какого датасета кадр — главное, чего не хватало общей сетке.
        note: datasets.length > 1 ? im.dataset_name : undefined,
      })),
    [g.items, datasets.length]
  );

  const toggleDataset = (id: string) =>
    setChosen((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  return (
    <div className="mag-card">
      <Gallery
        items={tiles}
        matched={g.matched}
        total={total}
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
        empty="Под фильтр не подошёл ни один кадр проекта."
        filters={
          <>
            {datasets.length > 1 && (
              <span className="mag-chips" role="group" aria-label="Датасеты">
                <button
                  type="button"
                  className={chosen.length === 0 ? "on" : ""}
                  onClick={() => setChosen([])}
                >
                  Все датасеты
                </button>
                {datasets.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className={chosen.includes(d.id) ? "on" : ""}
                    onClick={() => toggleDataset(d.id)}
                  >
                    {d.name}
                  </button>
                ))}
              </span>
            )}

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
                onlyEmpty ? "mag-ghost mag-ghost-inline on" : "mag-ghost mag-ghost-inline"
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
              prev.map((x) => (x.id === updated.id ? { ...x, ...updated } : x))
            )
          }
        />
      )}
    </div>
  );
}
