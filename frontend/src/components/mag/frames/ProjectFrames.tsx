// Датасеты: одна галерея всех кадров проекта, группы — датасеты (или сплиты).
//
// Вопрос «как размечен этот класс» почти никогда не про один датасет, поэтому
// кадры лежат в одной сетке, а датасет — заголовок группы. Отбор общий для
// всех групп; каждая группа грузит свои кадры сама и только когда раскрыта.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import type { LabelClass } from "../../../auth/api";
import { classesIn } from "../../../api/datasets";
import { projectImages } from "../../../api/gallery";
import type { ImagesQuery, ProjectImage, ProjectImages } from "../../../api/gallery";
import { listTags } from "../../../api/tags";
import type { Tag } from "../../../api/tags";
import { useLive } from "../../../live/LiveProvider";
import { Button, Empty, LinkButton, Notice, PageHeader, Range, Select, ToggleGroup, Icon } from "../../../ui";
import { count } from "../../ru";
import ExportModal from "../ExportModal";
import ImageViewer from "../ImageViewer";
import { useProject } from "../ProjectShell";
import DatasetDialog from "./DatasetDialog";
import { FrameFilters, NO_FILTERS, SPLIT_LABEL, hasFilters } from "./FrameFilters";
import type { Filters } from "./FrameFilters";
import { FrameGroup } from "./FrameGroup";
import type { GroupDef } from "./FrameGroup";
import type { Overlays } from "./FrameTile";

type GroupBy = "dataset" | "split" | "none";
type Sort = "name" | "objects";

interface View {
  ov: Overlays;
  tile: number;
  groupBy: GroupBy;
  sort: Sort;
}

const VIEW_KEY = "mag.frames.view";
const DEFAULT_VIEW: View = {
  ov: { boxes: true, labels: false, state: true, split: true }, tile: 170, groupBy: "dataset", sort: "name",
};

function readView(): View {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_KEY) || "{}") as Partial<View>;
    return { ...DEFAULT_VIEW, ...raw, ov: { ...DEFAULT_VIEW.ov, ...raw.ov } };
  } catch {
    return DEFAULT_VIEW;
  }
}

export default function ProjectFrames() {
  const { detail, refresh } = useProject();
  const { project, datasets, my_role } = detail;
  const code = project.code;
  const canEdit = my_role === "admin" || my_role === "editor";
  const isAdmin = my_role === "admin";
  const [params, setParams] = useSearchParams();

  const [view, setViewState] = useState<View>(readView);
  const setView = (patch: Partial<View>) => setViewState((v) => {
    const next = { ...v, ...patch };
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(next)); } catch { /* без памяти вида */ }
    return next;
  });

  const [f, setF] = useState<Filters>(NO_FILTERS);
  const set = useCallback((patch: Partial<Filters>) => setF((cur) => ({ ...cur, ...patch })), []);
  // Имя файла уходит на сервер с задержкой — не на каждую букву
  const [q, setQ] = useState("");
  useEffect(() => {
    const h = window.setTimeout(() => setQ(f.q.trim()), 250);
    return () => window.clearTimeout(h);
  }, [f.q]);

  const base = useMemo<ImagesQuery>(() => ({
    classes: f.classes, split: f.split || undefined, empty: f.empty, sort: view.sort, q,
    tags: Object.keys(f.tags).filter((k) => f.tags[k] === "in"),
    notags: Object.keys(f.tags).filter((k) => f.tags[k] === "ex"),
  }), [f.classes, f.split, f.empty, f.tags, view.sort, q]);
  const [rev, setRev] = useState(0);
  const filterKey = `${JSON.stringify(base)}#${rev}`;

  // Сводка отбора: итог, группы и полоска классов — одним запросом
  const [sum, setSum] = useState<ProjectImages | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);
  useEffect(() => {
    const mine = ++ticket.current;
    projectImages(code, { ...base, limit: 0, summary: true })
      .then((r) => { if (mine === ticket.current) { setSum(r); setError(null); } })
      .catch((e) => { if (mine === ticket.current) setError((e as Error).message); });
  }, [code, base, rev]);

  const [classes, setClasses] = useState<LabelClass[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const loadDicts = useCallback(() => {
    classesIn(code, "any").then((c) => setClasses(c.classes)).catch(() => {});
    listTags(code).then((t) => setTags(t.tags)).catch(() => {});
  }, [code]);
  useEffect(loadDicts, [loadDicts]);
  useLive("classes", loadDicts);

  // Правка в просмотре меняет счёт рамок, паспорт проекта и сводку
  const afterEdit = useCallback(() => {
    void refresh();
    loadDicts();
    setRev((n) => n + 1);
  }, [refresh, loadDicts]);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const groups = useMemo<GroupDef[]>(() => {
    const s = sum?.summary;
    if (view.groupBy === "dataset") {
      return datasets
        .map((d) => ({
          key: d.id, title: d.name, icon: "database" as const, matched: s?.by_dataset[d.id] ?? 0,
          query: { datasets: [d.id] }, dataset: { id: d.id, name: d.name },
        }))
        .filter((g) => !hasFilters(f) || g.matched > 0);
    }
    if (view.groupBy === "split") {
      return ["train", "val", "test", "other"]
        .filter((k) => (s?.by_split[k] ?? 0) > 0)
        .map((k) => ({ key: `split-${k}`, title: SPLIT_LABEL[k], icon: "split" as const,
          matched: s?.by_split[k] ?? 0, query: { split: k } }));
    }
    return [{ key: "all", title: "Все кадры", icon: "images" as const, matched: sum?.matched ?? 0, query: {} }];
  }, [sum, view.groupBy, datasets, f]);

  // ?ds=<id> — открыть датасет: его группа раскрыта, остальные свёрнуты
  const wantDs = params.get("ds");
  const dsDone = useRef<string | null>(null);
  useEffect(() => {
    if (!wantDs || !sum || dsDone.current === wantDs) return;
    dsDone.current = wantDs;
    if (view.groupBy !== "dataset") setView({ groupBy: "dataset" });
    setCollapsed(Object.fromEntries(datasets.map((d) => [d.id, d.id !== wantDs])));
    requestAnimationFrame(() => document.getElementById(`fr-g-${wantDs}`)?.scrollIntoView({ block: "start" }));
  }, [wantDs, sum, datasets, view.groupBy]);

  // ?frame=<id> — ссылка на кадр открывает его просмотр поверх галереи
  const wantFrame = params.get("frame");
  const [linked, setLinked] = useState<ProjectImage[] | null>(null);
  useEffect(() => {
    if (!wantFrame) { setLinked(null); return; }
    let alive = true;
    projectImages(code, { image: wantFrame, limit: 1 })
      .then((r) => alive && setLinked(r.images))
      .catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [code, wantFrame]);
  const closeLinked = () => {
    const next = new URLSearchParams(params);
    next.delete("frame");
    setParams(next, { replace: true });
  };
  const linkedEdited = useRef(false);

  const [exporting, setExporting] = useState(false);
  const [dsEdit, setDsEdit] = useState<{ id: string; name: string; mode: "rename" | "delete" } | null>(null);

  const importing = project.status === "importing";
  const header = (
    <PageHeader title="Датасеты"
      desc={`${count(datasets.length, "датасет", "датасета", "датасетов")} · ${count(detail.stats.images, "кадр", "кадра", "кадров")} · ${count(detail.stats.annotations, "рамка", "рамки", "рамок")}`}
      actions={<>
        <Button icon="download" disabled={importing || !datasets.length} onClick={() => setExporting(true)}
          title={importing ? "Дождитесь окончания импорта" : "Собрать архив с изображениями и разметкой"}>
          Экспорт
        </Button>
        {isAdmin && <LinkButton icon="upload" variant={datasets.length ? "outline" : "primary"}
          to={`/projects/${code}/import`}>Импорт архива</LinkButton>}
      </>} />
  );

  if (!datasets.length) {
    return (
      <div className="page">
        {header}
        {importing ? (
          <Notice tone="warn" action={<LinkButton size="sm" to={`/projects/${code}/import`}>Вернуться к импорту</LinkButton>}>
            <b>Импорт архива не завершён.</b> Работа идёт на сервере — вернитесь и продолжите с того же шага.
          </Notice>
        ) : (
          <Empty icon="database" title="Датасетов пока нет">
            {isAdmin ? "Импортируйте YOLO-архив — он станет первым датасетом проекта. Кадры из тасок попадают сюда после приёмки."
              : "Датасет появится, когда админ импортирует архив или примет кадры из таски."}
          </Empty>
        )}
      </div>
    );
  }

  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed[g.key]);

  return (
    <div className="page">
      {header}
      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}

      <FrameFilters f={f} set={set} classes={classes} tags={tags} splits={sum?.splits ?? {}}
        matched={sum ? sum.matched : null} total={sum?.total ?? detail.stats.images} summary={sum?.summary ?? null} />

      <div className="fr-tools">
        <ToggleGroup label="Что показывать поверх кадров" value={view.ov}
          onToggle={(k) => setView({ ov: { ...view.ov, [k]: !view.ov[k] } })}
          options={[
            { value: "boxes", label: "Рамки" }, { value: "labels", label: "Подписи" },
            { value: "state", label: "Состояние" }, { value: "split", label: "Сплит" },
          ]} />
        {groups.length > 1 && (
          <Button variant="ghost" size="sm" icon={allCollapsed ? "chevD" : "chevR"}
            onClick={() => setCollapsed(Object.fromEntries(groups.map((g) => [g.key, !allCollapsed])))}>
            {allCollapsed ? "Развернуть все" : "Свернуть все"}
          </Button>
        )}
        <span className="grow" />
        <label className="fr-size" title="Размер плиток">
          <Icon name="grid" />
          <Range min={120} max={300} step={10} value={view.tile} aria-label="Размер плиток"
            onChange={(e) => setView({ tile: Number(e.target.value) })} />
        </label>
        <Select label="Порядок" icon="list" value={view.sort} onChange={(v) => setView({ sort: v })}
          options={[{ value: "name", label: "По имени файла" }, { value: "objects", label: "Больше объектов" }]} />
        <Select label="Группировать" icon="layers" value={view.groupBy} onChange={(v) => setView({ groupBy: v })}
          options={[{ value: "dataset", label: "По датасету" }, { value: "split", label: "По сплиту" },
            { value: "none", label: "Без групп" }]} />
      </div>

      {sum && groups.length === 0 ? (
        <Empty icon="search" title="Под отбор не подошёл ни один кадр"
          action={<Button size="sm" onClick={() => set(NO_FILTERS)}>Сбросить фильтры</Button>} />
      ) : (
        <div className="fr-groups">
          {sum && groups.map((g) => (
            <FrameGroup key={g.key} def={g} code={code} base={base} filterKey={filterKey} ov={view.ov}
              tile={view.tile} collapsed={Boolean(collapsed[g.key])}
              onCollapse={(v) => setCollapsed((c) => ({ ...c, [g.key]: v }))}
              classes={classes} canEdit={canEdit} onEdited={afterEdit}
              canDelete={isAdmin}
              onDataset={g.dataset && canEdit ? (mode) => setDsEdit({ ...g.dataset!, mode }) : undefined} />
          ))}
        </div>
      )}

      {linked && linked[0] && createPortal(
        <ImageViewer images={linked} index={0} total={1} classes={classes} canEdit={canEdit}
          onIndex={() => {}}
          onClose={() => { closeLinked(); if (linkedEdited.current) { linkedEdited.current = false; afterEdit(); } }}
          onSaved={(u) => { linkedEdited.current = true; setLinked([{ ...linked[0], ...u } as ProjectImage]); }} />,
        document.body,
      )}
      {exporting && <ExportModal detail={detail} onClose={() => setExporting(false)} />}
      {dsEdit && (
        <DatasetDialog code={code} dataset={dsEdit} mode={dsEdit.mode} onClose={() => setDsEdit(null)}
          onDone={async () => { setDsEdit(null); await refresh(); setRev((n) => n + 1); }} />
      )}
    </div>
  );
}
