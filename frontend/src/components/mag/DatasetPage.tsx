import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getClasses, getDataset, imageThumbUrl } from "../../auth/api";
import type { DatasetDetail, DatasetImage, LabelClass } from "../../auth/api";
import ImageViewer from "./ImageViewer";
import { plural } from "./ProjectsPage";

const PAGE = 60;
const SIZES = [
  { key: "s", label: "S" },
  { key: "m", label: "M" },
  { key: "l", label: "L" },
];
const SPLITS = [
  { value: "", label: "Все сплиты" },
  { value: "train", label: "train" },
  { value: "val", label: "val" },
  { value: "test", label: "test" },
  { value: "other", label: "Вне сплитов" },
];

export default function DatasetPage() {
  const { code, datasetId } = useParams<{ code: string; datasetId: string }>();

  const [detail, setDetail] = useState<DatasetDetail | null>(null);
  const [images, setImages] = useState<DatasetImage[]>([]);
  const [classes, setClasses] = useState<LabelClass[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // фильтры
  const [split, setSplit] = useState("");
  const [classIndex, setClassIndex] = useState<number | null>(null);
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  const [sort, setSort] = useState<"name" | "objects">("name");

  // вид
  const [size, setSize] = useState("m");
  const [mode, setMode] = useState<"pages" | "feed">("pages");
  const [showBoxes, setShowBoxes] = useState(true);
  const [page, setPage] = useState(0);
  const [viewer, setViewer] = useState<number | null>(null);

  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (code) getClasses(code).then((c) => setClasses(c.classes)).catch(() => {});
  }, [code]);

  const query = useCallback(
    (offset: number) => ({
      split: split || undefined,
      class_index: classIndex,
      empty: onlyEmpty,
      sort,
      limit: PAGE,
      offset,
    }),
    [split, classIndex, onlyEmpty, sort]
  );

  // Смена фильтра или режима начинает выборку заново.
  const reload = useCallback(async () => {
    if (!code || !datasetId) return;
    setLoading(true);
    try {
      const d = await getDataset(code, datasetId, query(0));
      setDetail(d);
      setImages(d.images);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [code, datasetId, query]);

  useEffect(() => {
    setPage(0);
    reload();
  }, [reload]);

  const loadPage = useCallback(
    async (nextPage: number) => {
      if (!code || !datasetId) return;
      setLoading(true);
      try {
        const d = await getDataset(code, datasetId, query(nextPage * PAGE));
        setDetail(d);
        setImages((prev) => (mode === "feed" ? [...prev, ...d.images] : d.images));
        setPage(nextPage);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [code, datasetId, query, mode]
  );

  const loadMore = useCallback(() => {
    if (loading || !detail) return;
    if (images.length >= detail.matched) return;
    loadPage(page + 1);
  }, [loading, detail, images.length, page, loadPage]);

  // Лента подгружается по мере прокрутки, а не кнопкой.
  useEffect(() => {
    if (mode !== "feed") return;
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => entries[0].isIntersecting && loadMore(),
      { rootMargin: "600px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [mode, loadMore]);

  if (error && !detail) {
    return (
      <div className="mag-content">
        <div className="mag-error">{error}</div>
        <Link to={`/projects/${code}`} className="mag-link">← К проекту</Link>
      </div>
    );
  }
  if (!detail) return <div className="mag-content mag-empty">Загружаем датасет…</div>;

  const { dataset, stats, matched } = detail;
  const pages = Math.max(1, Math.ceil(matched / PAGE));
  const res = stats.resolutions[0];
  const uniform = stats.resolutions.length === 1;

  return (
    <div className="mag-content">
      <div className="mag-crumbs">
        <Link to="/">Проекты</Link> / <Link to={`/projects/${code}`}>{code}</Link> /{" "}
        <b>{dataset.name}</b>
      </div>

      <div className="mag-card">
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
                <span>{s === "other" ? "вне сплитов" : s}</span>
              </div>
            ))}
          <div className={uniform ? "mag-stat" : "mag-stat warn"}>
            <b>{res ? `${res.width}×${res.height}` : "—"}</b>
            <span>{uniform ? "все кадры" : "и ещё размеры"}</span>
          </div>
        </div>
      </div>

      <div className="mag-card">
        <div className="mag-filters">
          <select value={split} aria-label="Сплит" onChange={(e) => setSplit(e.target.value)}>
            {SPLITS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>

          <select
            value={classIndex ?? ""}
            aria-label="Класс"
            onChange={(e) =>
              setClassIndex(e.target.value === "" ? null : Number(e.target.value))
            }
          >
            <option value="">Все классы</option>
            {classes.map((c) => (
              <option key={c.id} value={c.class_index}>
                {c.class_index} · {c.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            className={onlyEmpty ? "mag-ghost mag-ghost-inline on" : "mag-ghost mag-ghost-inline"}
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

          <span className="mag-filters-sp" />

          <span className="mag-seg" role="group" aria-label="Размер плитки">
            {SIZES.map((s) => (
              <button
                key={s.key}
                type="button"
                className={size === s.key ? "on" : ""}
                onClick={() => setSize(s.key)}
              >
                {s.label}
              </button>
            ))}
          </span>

          <span className="mag-seg" role="group" aria-label="Режим вывода">
            <button
              type="button"
              className={mode === "pages" ? "on" : ""}
              onClick={() => setMode("pages")}
            >
              Страницы
            </button>
            <button
              type="button"
              className={mode === "feed" ? "on" : ""}
              onClick={() => setMode("feed")}
            >
              Лента
            </button>
          </span>

          <button
            type="button"
            className={showBoxes ? "mag-ghost mag-ghost-inline on" : "mag-ghost mag-ghost-inline"}
            onClick={() => setShowBoxes((v) => !v)}
          >
            Разметка: {showBoxes ? "вкл" : "выкл"}
          </button>
        </div>

        <div className="mag-found">
          Найдено {matched.toLocaleString("ru-RU")}{" "}
          {plural(matched, "кадр", "кадра", "кадров")}
          {matched !== stats.images && ` из ${stats.images.toLocaleString("ru-RU")}`}
        </div>

        {images.length === 0 ? (
          <div className="mag-empty">Под фильтр ничего не подошло.</div>
        ) : (
          <div className={`mag-tiles ${size}`}>
            {images.map((im, i) => (
              <Tile
                key={im.id}
                image={im}
                showBoxes={showBoxes}
                withLabels={size === "l"}
                onOpen={() => setViewer(i)}
              />
            ))}
          </div>
        )}

        {mode === "pages" ? (
          pages > 1 && (
            <div className="mag-pager">
              <button
                className="mag-ghost"
                disabled={page === 0 || loading}
                onClick={() => loadPage(page - 1)}
              >
                Назад
              </button>
              <span>{page + 1} из {pages}</span>
              <button
                className="mag-ghost"
                disabled={page + 1 >= pages || loading}
                onClick={() => loadPage(page + 1)}
              >
                Дальше
              </button>
            </div>
          )
        ) : (
          <div className="mag-feed-foot" ref={sentinel}>
            {images.length >= matched
              ? "Показаны все кадры"
              : loading
              ? "Загружаю…"
              : `Показано ${images.length.toLocaleString("ru-RU")} из ${matched.toLocaleString("ru-RU")}`}
          </div>
        )}
      </div>

      {viewer !== null && images[viewer] && (
        <ImageViewer
          images={images}
          index={viewer}
          total={matched}
          classes={classes}
          canEdit={detail.my_role === "admin" || detail.my_role === "editor"}
          onIndex={setViewer}
          onClose={() => setViewer(null)}
          onNeedMore={mode === "feed" ? loadMore : undefined}
          onSaved={(updated) =>
            setImages((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
          }
        />
      )}
    </div>
  );
}

function Tile({
  image,
  showBoxes,
  withLabels,
  onOpen,
}: {
  image: DatasetImage;
  showBoxes: boolean;
  withLabels: boolean;
  onOpen: () => void;
}) {
  const w = image.width || 1;
  const h = image.height || 1;
  return (
    <button
      className="mag-tile"
      type="button"
      onClick={onOpen}
      title={`${image.file_name} · ${image.annotations} ${plural(image.annotations, "объект", "объекта", "объектов")}`}
    >
      <img src={imageThumbUrl(image.id)} alt={image.file_name} loading="lazy" decoding="async" />
      {showBoxes &&
        image.boxes.map((b, i) => (
          <span
            key={i}
            className="mag-tile-box"
            style={{
              left: `${(b.x / w) * 100}%`,
              top: `${(b.y / h) * 100}%`,
              width: `${(b.w / w) * 100}%`,
              height: `${(b.h / h) * 100}%`,
              borderColor: b.color,
            }}
          >
            {withLabels && <b style={{ background: b.color }}>{b.name}</b>}
          </span>
        ))}
      <span className="mag-tile-split">{image.split === "other" ? "—" : image.split}</span>
      <span className={image.annotations ? "mag-tile-n" : "mag-tile-n zero"}>
        {image.annotations || "пусто"}
      </span>
    </button>
  );
}
