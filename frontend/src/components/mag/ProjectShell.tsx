import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Outlet, useMatch, useOutletContext, useParams } from "react-router-dom";
import { ApiError, errorText, getProject } from "../../auth/api";
import { useAuth } from "../auth/AuthGate";
import { plural, ru } from "../ru";
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

// Паспорт и статистика проекта общие для вложенных экранов.
// Переходы между разделами находятся в боковой навигации MagShell.
export default function ProjectShell() {
  const { code } = useParams<{ code: string }>();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const { me, refresh: refreshMe } = useAuth();
  const shown = useRef(false);
  // Переписанные экраны рисуют свою шапку и поля сами; старым — прежняя обёртка.
  const atOverview = Boolean(useMatch("/projects/:code"));
  const atImport = Boolean(useMatch("/projects/:code/import"));
  const atDatasets = Boolean(useMatch("/projects/:code/datasets"));
  const redesigned = atOverview || atImport || atDatasets;

  const refresh = useCallback(async () => {
    if (!code) return;
    try {
      const d = await getProject(code);
      setDetail(d);
      setError(null);
      shown.current = true;
    } catch (e) {
      // Фоновый опрос раз в 30 с не должен сносить уже показанный проект:
      // один сбой сети заменял экран на «Failed to fetch», и открытые окна с
      // набранным пропадали. Экран ошибки — только при первой загрузке или
      // когда проекта для нас больше нет (удалён, нас исключили).
      const gone = e instanceof ApiError && (e.status === 404 || e.status === 403);
      if (!shown.current || gone) setError(errorText(e));
    }
  }, [code]);

  useEffect(() => {
    shown.current = false;
    setDetail(null);
    setError(null);
  }, [code]);

  // Проект открылся, а в me его нет — me устарел (приняли приглашение в
  // другой вкладке, создали проект до этой правки). Шапка и меню берут имя
  // проекта из me, поэтому подтягиваем его, а не показываем код.
  const known = me.projects.some((p) => p.code === detail?.project.code);
  useEffect(() => {
    if (detail && !known) refreshMe();
  }, [detail, known, refreshMe]);

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

  const { project, stats } = detail;

  if (redesigned) return <Outlet context={{ detail, refresh } satisfies ProjectContext} />;

  // Живая связь поднята в MagShell: она нужна и страницам вне этой оболочки.
  return (
    <div className="mag-content">
      <div className="workspace-project-head">
        <div><span className="workspace-eyebrow">Проект / {project.code}</span><h1>{project.name}</h1></div>
        {project.status === "importing" && <span className="mag-importing"><i />Импорт выполняется</span>}
      </div>
      <div className="mag-pass-strip">
        <div className="mag-pass-id">
          <p>
            {project.description ? `${project.description} — ` : ""}
            создан {new Date(project.created_at).toLocaleDateString("ru-RU")}
            {project.created_by ? ` — ${project.created_by}` : ""}
          </p>
        </div>
        <div className="mag-pass-nums">
          <div><b>{ru(stats.images)}</b><span>{plural(stats.images, "изображение", "изображения", "изображений")}</span></div>
          <div><b>{ru(stats.annotations)}</b><span>{plural(stats.annotations, "разметка", "разметки", "разметок")}</span></div>
          <div><b>{ru(stats.classes)}</b><span>{plural(stats.classes, "класс", "класса", "классов")}</span></div>
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
  );
}
