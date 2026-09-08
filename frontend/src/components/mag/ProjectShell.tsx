import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useOutletContext, useParams } from "react-router-dom";
import { getProject } from "../../auth/api";
import type { ProjectDetail } from "../../auth/api";
import ExportModal from "./ExportModal";
import { LiveProvider } from "../../live/LiveProvider";

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
    isActive ? "g-ctx-link on" : "g-ctx-link";

  return (
    // Живая связь — одна на вкладку и на весь проект: она приносит «изменился
    // такой-то ран», а строку экран дочитывает сам. Соединение на каждое
    // обучение занимало бы поток сервера на всё время прогона.
    <LiveProvider code={project.code}>
      {/* Второй уровень навигации: кто мы сейчас и что у него внутри.
          Приклеен к верхней строке, поэтому «где я» видно на любой прокрутке. */}
      <div className="g-ctx">
        <Link to="/" className="g-ctx-back" title="К списку проектов">←</Link>
        <span className="g-ctx-name">{project.name}</span>
        {project.status === "importing" ? (
          <span className="mag-importing"><i />импорт</span>
        ) : (
          <span className="g-ctx-code">{project.code}</span>
        )}
        <nav className="g-ctx-nav">
          <NavLink to={`/projects/${project.code}`} end className={tab}>Обзор</NavLink>
          <NavLink to={`/projects/${project.code}/tasks`} className={tab}>
            Таски <span>{stats.tasks ?? 0}</span>
          </NavLink>
          <NavLink to={`/projects/${project.code}/datasets`} className={tab}>
            Датасеты <span>{stats.datasets}</span>
          </NavLink>
          <NavLink to={`/projects/${project.code}/classes`} className={tab}>
            Классы <span>{stats.classes}</span>
          </NavLink>
          <NavLink to={`/projects/${project.code}/aug`} className={tab}>
            Аугментации
          </NavLink>
          <NavLink to={`/projects/${project.code}/training`} className={tab}>
            Обучение
          </NavLink>
          <NavLink to={`/projects/${project.code}/members`} className={tab}>
            Участники <span>{members.length}</span>
          </NavLink>
        </nav>
      </div>

    <div className="mag-content">
      <div className="mag-pass-strip">
        <div className="mag-pass-id">
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

      <Outlet context={{ detail, refresh } satisfies ProjectContext} />

      {exporting && (
        <ExportModal detail={detail} onClose={() => setExporting(false)} />
      )}
    </div>
    </LiveProvider>
  );
}
