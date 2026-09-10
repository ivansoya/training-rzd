// Сетка кадров: одна на датасет, на весь проект и на собранный набор.
//
// Показывает и ничего не решает: чем наполнить, чем фильтровать и что делать
// по щелчку, говорит экран. Своё у неё только то, что человек ждёт одинаковым
// везде: размер плитки, «страницы или лента», разметка поверх превью.
//
// Режим вывода стоит наверху и переключается одним щелчком. До 08.09.2026
// переключатель тут был, но его перекрывал чужой `.mag-seg` из `task.css` —
// абсолютно позиционированный отрезок таймлайна с тем же именем. Он растягивал
// переключатель во всю ширину, ловил щелчки за себя и рисовал полосы поперёк
// страницы. Урок общий: одинаковые имена классов в разных наборах стилей
// сталкиваются молча, и виноватым выглядит разметка.

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { Box } from "../../auth/api";
import ShapeMini from "./ShapeMini";
import { plural } from "./ProjectsPage";
import type { Mode } from "./useGallery";

export interface GalleryItem {
  /** Ключ строки и адрес превью. */
  key: string;
  thumb: string;
  title: string;
  /** Часть набора: train / val / test / other. */
  split: string;
  objects: number;
  /** Размер кадра. У собранного образца его нет — там доли и 1×1. */
  width: number | null;
  height: number | null;
  boxes: Box[];
  /** Приписка на плитке: датасет кадра или путь образца по графу. */
  note?: string;
}

const SIZES = [
  { key: "s", label: "S" },
  { key: "m", label: "M" },
  { key: "l", label: "L" },
];

export default function Gallery({
  items,
  matched,
  total,
  loading,
  error,
  mode,
  onMode,
  size,
  onSize,
  boxes,
  onBoxes,
  page,
  pages,
  onPage,
  onMore,
  onOpen,
  filters,
  empty = "Под фильтр ничего не подошло.",
}: {
  items: GalleryItem[];
  matched: number;
  total?: number;
  loading: boolean;
  error?: string | null;
  mode: Mode;
  onMode: (m: Mode) => void;
  size: string;
  onSize: (s: string) => void;
  boxes: boolean;
  onBoxes: (v: boolean) => void;
  page: number;
  pages: number;
  onPage: (p: number) => void;
  onMore: () => void;
  onOpen: (index: number) => void;
  filters?: ReactNode;
  empty?: string;
}) {
  const sentinel = useRef<HTMLDivElement>(null);

  // Лента подгружается по мере прокрутки, а не кнопкой. Запас в 600 px —
  // чтобы следующая страница приходила до того, как кончится текущая.
  useEffect(() => {
    if (mode !== "feed") return;
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => entries[0].isIntersecting && onMore(),
      { rootMargin: "600px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [mode, onMore]);

  return (
    <>
      <div className="mag-filters">
        {filters}
        <span className="mag-filters-sp" />

        <span className="mag-switch" role="group" aria-label="Размер плитки">
          {SIZES.map((s) => (
            <button
              key={s.key}
              type="button"
              className={size === s.key ? "on" : ""}
              onClick={() => onSize(s.key)}
            >
              {s.label}
            </button>
          ))}
        </span>

        <span className="mag-switch" role="group" aria-label="Режим вывода">
          <button
            type="button"
            className={mode === "pages" ? "on" : ""}
            onClick={() => onMode("pages")}
            title="По страницам, как раньше"
          >
            Страницы
          </button>
          <button
            type="button"
            className={mode === "feed" ? "on" : ""}
            onClick={() => onMode("feed")}
            title="Всё подряд, с догрузкой по прокрутке"
          >
            Лента
          </button>
        </span>

        <button
          type="button"
          className={boxes ? "mag-ghost mag-ghost-inline on" : "mag-ghost mag-ghost-inline"}
          onClick={() => onBoxes(!boxes)}
        >
          Разметка: {boxes ? "вкл" : "выкл"}
        </button>
      </div>

      {error && <div className="mag-error">{error}</div>}

      <div className="mag-found">
        Найдено {matched.toLocaleString("ru-RU")}{" "}
        {plural(matched, "кадр", "кадра", "кадров")}
        {total !== undefined && matched !== total &&
          ` из ${total.toLocaleString("ru-RU")}`}
      </div>

      {items.length === 0 ? (
        <div className="mag-empty">{loading ? "Загружаю…" : empty}</div>
      ) : (
        <div className={`mag-tiles ${size}`}>
          {items.map((item, i) => (
            <Tile
              key={item.key}
              item={item}
              showBoxes={boxes}
              withLabels={size === "l"}
              onOpen={() => onOpen(i)}
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
              onClick={() => onPage(page - 1)}
            >
              Назад
            </button>
            <span>
              {page + 1} из {pages}
            </span>
            <button
              className="mag-ghost"
              disabled={page + 1 >= pages || loading}
              onClick={() => onPage(page + 1)}
            >
              Дальше
            </button>
          </div>
        )
      ) : (
        <div className="mag-feed-foot" ref={sentinel}>
          {items.length >= matched
            ? "Показаны все кадры"
            : loading
            ? "Загружаю…"
            : `Показано ${items.length.toLocaleString("ru-RU")} из ${matched.toLocaleString("ru-RU")}`}
        </div>
      )}
    </>
  );
}

function Tile({
  item,
  showBoxes,
  withLabels,
  onOpen,
}: {
  item: GalleryItem;
  showBoxes: boolean;
  withLabels: boolean;
  onOpen: () => void;
}) {
  const w = item.width || 1;
  const h = item.height || 1;
  return (
    <button
      className="mag-tile"
      type="button"
      onClick={onOpen}
      title={`${item.title} — ${item.objects} ${plural(item.objects, "объект", "объекта", "объектов")}${item.note ? ` — ${item.note}` : ""}`}
    >
      <img src={item.thumb} alt={item.title} loading="lazy" decoding="async" />
      {showBoxes && <ShapeMini boxes={item.boxes} width={w} height={h} />}
      {/* Подписи — вёрсткой поверх слоя: в SVG под `preserveAspectRatio="none"`
          текст тянулся бы вместе с кадром. */}
      {showBoxes &&
        withLabels &&
        item.boxes.map((b, i) => (
          <b
            key={i}
            className="mag-tile-lb"
            style={{
              left: `${(b.x / w) * 100}%`,
              top: `${(b.y / h) * 100}%`,
              background: b.color,
            }}
          >
            {b.name}
          </b>
        ))}
      <span className="mag-tile-split">
        {item.split === "other" ? "—" : item.split}
      </span>
      {item.note && <span className="mag-tile-note">{item.note}</span>}
      <span className={item.objects ? "mag-tile-n" : "mag-tile-n zero"}>
        {item.objects || "пусто"}
      </span>
    </button>
  );
}
