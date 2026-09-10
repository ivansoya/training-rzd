// Что на самом деле лежит в собранном наборе.
//
// Набор — это папка на томе, и до сих пор о его содержимом можно было судить
// только по числам в карточке. Числа не отвечают на главный вопрос перед
// обучением: «а что там за кадры и не поехала ли разметка после аугментаций».
// Здесь набор открывается как датасет — теми же плитками, с отбором по классам
// и по части (обучение/проверка).
//
// Отбор по классам — по номерам **внутри набора**, а не по классам проекта:
// в наборе классы перенумерованы подряд, и именно эти номера стоят в файлах
// разметки, которые прочитает YOLO.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import * as sets from "../../api/trainsets";
import type { Sample, SetClass, TrainSet } from "../../api/trainsets";
import ClassPicker from "../mag/ClassPicker";
import Gallery from "../mag/Gallery";
import type { GalleryItem } from "../mag/Gallery";
import { useGallery } from "../mag/useGallery";
import type { Mode } from "../mag/useGallery";
import SampleViewer from "./SampleViewer";

const ru = (n: number) => Math.round(n).toLocaleString("ru-RU");

const SPLITS = [
  { value: "", label: "Обучение и проверка" },
  { value: "train", label: "Только обучение" },
  { value: "val", label: "Только проверка" },
];

export default function TrainSetView() {
  const { code, setId } = useParams<{ code: string; setId: string }>();
  // Вкладка живёт в адресе, как в обзоре проекта: на образцы можно дать
  // ссылку, и она переживает перезагрузку.
  const [search, setSearch] = useSearchParams();
  const view = search.get("view") === "frames" ? "frames" : "summary";

  const [set, setSet] = useState<TrainSet | null>(null);
  const [classes, setClasses] = useState<SetClass[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [blocked, setBlocked] = useState<string | null>(null);

  const [split, setSplit] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [onlyEmpty, setOnlyEmpty] = useState(false);

  const [size, setSize] = useState("m");
  const [mode, setMode] = useState<Mode>("pages");
  const [showBoxes, setShowBoxes] = useState(true);
  const [viewer, setViewer] = useState<number | null>(null);

  const load = useCallback(
    async (offset: number, limit: number) => {
      if (!code || !setId) return { items: [] as Sample[], matched: 0 };
      const got = await sets.samples(code, setId, {
        split: view === "frames" ? split || undefined : undefined,
        classes: view === "frames" ? picked : [],
        empty: view === "frames" ? onlyEmpty : false,
        // На сводке образцы не показываются — просим один, ради паспорта
        // набора и таблицы классов, которые приходят тем же ответом.
        limit: view === "frames" ? limit : 1,
        offset: view === "frames" ? offset : 0,
      });
      setSet(got.set);
      setClasses(got.classes);
      setWarnings(got.warnings);
      setTotal(got.total);
      setBlocked(null);
      return { items: got.samples, matched: got.matched };
    },
    [code, setId, view, split, picked, onlyEmpty]
  );

  const g = useGallery<Sample>(load, mode);

  // Несобранный набор — не ошибка, а состояние: скажем, какое именно.
  useEffect(() => {
    if (!g.error) return;
    if (/не собран/i.test(g.error)) setBlocked(g.error);
  }, [g.error]);

  const tiles = useMemo<GalleryItem[]>(
    () =>
      g.items.map((s) => ({
        key: s.file,
        thumb: code && setId ? sets.sampleUrl(code, setId, s.file) : "",
        title: s.name,
        split: s.split,
        objects: s.objects,
        // Настоящий размер образца: слою разметки нужно соотношение сторон,
        // иначе на плитке рамки разойдутся с обрезанной картинкой.
        width: s.width,
        height: s.height,
        boxes: s.boxes,
        note: s.sid || (s.hardlink ? "оригинал" : undefined),
      })),
    [g.items, code, setId]
  );

  const viewSamples = useMemo(
    () =>
      g.items.map((s) => ({
        name: s.name,
        split: s.split,
        objects: s.objects,
        width: s.width,
        height: s.height,
        sid: s.sid,
        ops: s.ops,
        boxes: s.boxes,
        src: code && setId ? sets.sampleUrl(code, setId, s.file) : "",
      })),
    [g.items, code, setId]
  );

  if (blocked) {
    return (
      <div className="mag-card mag-empty-big">
        <h3>Набор ещё не собран</h3>
        <p>{blocked}</p>
        <Link className="mag-btn mag-btn-inline" to={`/projects/${code}/training`}>
          К обучению
        </Link>
      </div>
    );
  }

  const tabs = (
    <div className="mag-vtabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={view === "summary"}
        className={view === "summary" ? "on" : ""}
        onClick={() => setSearch({})}
      >
        Сводка
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === "frames"}
        className={view === "frames" ? "on" : ""}
        onClick={() => setSearch({ view: "frames" })}
      >
        Изображения
        {total !== undefined && <span>{ru(total)}</span>}
      </button>
    </div>
  );

  return (
    <>
      <div className="mag-card">
        <div className="mag-card-h">
          <h4>{set?.name ?? "Обучающий набор"}</h4>
          <Link className="mag-ghost mag-ghost-inline" to={`/projects/${code}/training`}>
            Все наборы
          </Link>
        </div>
        {set?.counts && (
          <div className="mag-statrow mag-ds-stats">
            <div className="mag-stat">
              <b>{ru(set.counts.samples)}</b>
              <span>образцов</span>
            </div>
            <div className="mag-stat">
              <b>{ru(set.counts.train)}</b>
              <span>обучение</span>
            </div>
            <div className={set.counts.val ? "mag-stat" : "mag-stat warn"}>
              <b>{ru(set.counts.val)}</b>
              <span>проверка</span>
            </div>
            <div className="mag-stat">
              <b>{ru(set.counts.annotations)}</b>
              <span>разметок</span>
            </div>
            <div className="mag-stat">
              <b>{ru(set.counts.source_images)}</b>
              <span>исходных кадров</span>
            </div>
            {set.counts.background !== undefined && (
              <div className="mag-stat">
                <b>{ru(set.counts.background)}</b>
                <span>кадров-фона</span>
              </div>
            )}
            <div className="mag-stat">
              <b>{set.graph ? `${set.graph.name} — в${set.graph.version}` : "нет"}</b>
              <span>граф аугментаций</span>
            </div>
          </div>
        )}
        {warnings.map((w, i) => (
          <div className="mag-note" key={i}>
            {w}
          </div>
        ))}
      </div>

      {tabs}

      {view === "summary" && classes.length > 0 && (
        <div className="mag-card">
          <div className="mag-card-h">
            <h4>Классы набора</h4>
            {/* Не `.mag-found`: тот означает «найдено столько-то кадров», и
                второе значение у одного класса — начало той же путаницы, из
                которой пришлось вытаскивать `.mag-seg`. */}
            <span className="mag-cls-rest" style={{ padding: 0 }}>
              нумерация та же, что в файлах разметки
            </span>
          </div>
          <div className="mag-table-scroll">
            <table className="mag-table">
              <thead>
                <tr>
                  <th>№</th>
                  <th>Класс</th>
                  <th className="num">Обучение</th>
                  <th className="num">Проверка</th>
                  <th className="num">Разметок</th>
                </tr>
              </thead>
              <tbody>
                {classes.map((c) => (
                  <tr key={c.export_id}>
                    <td>
                      <span className="mag-code">{c.export_id}</span>
                    </td>
                    <td>
                      <span className="mag-swatch" style={{ background: c.color }} />{" "}
                      {c.name}
                    </td>
                    <td className="num">{ru(c.train)}</td>
                    <td className="num">{ru(c.val)}</td>
                    <td className="num">{ru(c.annotations)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {view === "frames" && (
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
          empty="Под фильтр не подошёл ни один образец."
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
                  class_index: c.export_id,
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
                title="Кадры-фоны: в наборе они бывают осознанно"
              >
                Только без разметки
              </button>
            </>
          }
        />
      </div>
      )}

      {view === "frames" && viewer !== null && viewSamples[viewer] && (
        <SampleViewer
          samples={viewSamples}
          index={viewer}
          total={g.matched}
          onIndex={setViewer}
          onClose={() => setViewer(null)}
          onNeedMore={mode === "feed" ? g.more : undefined}
        />
      )}
    </>
  );
}
