import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useOutletContext, useParams } from "react-router-dom";
import { getProject } from "../../auth/api";
import type { ProjectDetail } from "../../auth/api";
import ExportModal from "./ExportModal";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  const units = ["КБ", "МБ", "ГБ", "ТБ"];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ${units[i]}`;
}

export interface ProjectContext {
  detail: ProjectDetail;
  refresh: () => Promise<void>;
}

export function useProject(): ProjectContext {
  return useOutletContext<ProjectContext>();
}

// Оболочка проекта: паспорт горизонтальной шапкой, разделы — вкладками в URL.
// Каждой сущности достаётся вся ширина, поэтому классы и участники больше не
// делят колонку в 320 px.
export default function ProjectShell() {
  const { code } = useParams<{ code: string }>();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const refresh = useCallback(async () => {
    if (!code) return;
    try {
      setDetail(await getProject(code));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [code]);

  useEffect(() => {
    refresh();
    // Онлайн-статусы участников живут две минуты — обновляем раз в полминуты.
    const h = setInterval(refresh, 30_000);
    return () => clearInterval(h);
  }, [refresh]);

  if (error) {
    return (
      <div className="mag-content">
        <div className="mag-error">{error}</div>
        <Link to="/" className="mag-link">← К списку проектов</Link>
      </div>
    );
  }
  if (!detail) return <div className="mag-content mag-empty">Загружаем проект…</div>;

  const { project, stats, members } = detail;
  const tab = ({ isActive }: { isActive: boolean }) =>
    isActive ? "mag-tab on" : "mag-tab";

  return (
    <div className="mag-content">
      <div className="mag-crumbs">
        <Link to="/">Проекты</Link> / <b>{project.name}</b>
      </div>

      <div className="mag-pass-strip">
        <div className="mag-pass-id">
          <div className="mag-pass-title">
            <h1>{project.name}</h1>
            {project.status === "importing" ? (
              <span className="mag-importing"><i />импорт</span>
            ) : (
              <span className="mag-code-badge">{project.code}</span>
            )}
          </div>
          <p>
            {project.description ? `${project.description} · ` : ""}
            создан {new Date(project.created_at).toLocaleDateString("ru-RU")}
            {project.created_by ? ` · ${project.created_by}` : ""}
          </p>
        </div>
        <div className="mag-pass-nums">
          <div><b>{stats.images.toLocaleString("ru-RU")}</b><span>изображений</span></div>
          <div><b>{stats.annotations.toLocaleString("ru-RU")}</b><span>разметок</span></div>
          <div><b>{stats.classes}</b><span>классов</span></div>
          <div><b>{formatBytes(stats.size_bytes)}</b><span>на сервере</span></div>
        </div>
        {/* Выгрузка — чтение, поэтому доступна и наблюдателю: он и так видит
            все кадры и может скачать их по одному. */}
        <button
          className="mag-ghost mag-ghost-inline mag-pass-export"
          type="button"
          disabled={project.status === "importing"}
          title={
            project.status === "importing"
              ? "Дождитесь окончания импорта"
              : "Собрать архив с изображениями и разметкой"
          }
          onClick={() => setExporting(true)}
        >
          Экспорт
        </button>
      </div>

      <nav className="mag-tabs">
        <NavLink to={`/projects/${project.code}`} end className={tab}>
          Обзор
        </NavLink>
        <NavLink to={`/projects/${project.code}/datasets`} className={tab}>
          Датасеты <span>{stats.datasets}</span>
        </NavLink>
        <NavLink to={`/projects/${project.code}/classes`} className={tab}>
          Классы <span>{stats.classes}</span>
        </NavLink>
        <NavLink to={`/projects/${project.code}/members`} className={tab}>
          Участники <span>{members.length}</span>
        </NavLink>
        <NavLink to={`/projects/${project.code}/tasks`} className={tab}>
          Таски
        </NavLink>
      </nav>

      <Outlet context={{ detail, refresh } satisfies ProjectContext} />

      {exporting && (
        <ExportModal detail={detail} onClose={() => setExporting(false)} />
      )}
    </div>
  );
}
