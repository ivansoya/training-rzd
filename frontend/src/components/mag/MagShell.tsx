import type { ReactNode } from "react";
import { Link, NavLink, matchPath, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthGate";
import { initials } from "../auth/AccountPage";
import Sep from "../Sep";

/** The workspace shell never transforms its children: editors measure their
 * bitmap and annotation layers in viewport coordinates. */
export default function MagShell({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const { pathname } = useLocation();
  const graphEditor = Boolean(matchPath("/augment/:graphId", pathname));
  const code = matchPath("/projects/:code/*", pathname)?.params.code;
  const projectPath = code ? "/projects/" + encodeURIComponent(code) : "";
  const projectName = me.projects.find((p) => p.code === code)?.name ?? code;
  const nav = ({ isActive }: { isActive: boolean }) =>
    isActive ? "workspace-link on" : "workspace-link";
  const projectLinks = [
    ["", "Обзор", "ОБ"], ["/tasks", "Таски", "ТС"],
    ["/datasets", "Датасеты", "ДТ"], ["/classes", "Классы", "КЛ"],
    ["/aug", "Аугментации проекта", "АУ"], ["/training", "Обучение", "МО"],
    ["/members", "Участники", "УЧ"],
  ];
  const section = code
    ? projectLinks.find(([suffix]) => suffix && pathname.startsWith(projectPath + suffix))?.[1]
      ?? (pathname.includes("/trainsets/") ? "Обучающий набор" : pathname.endsWith("/import") ? "Импорт" : "Обзор проекта")
    : pathname.startsWith("/augment") ? "Библиотека аугментаций"
      : pathname.startsWith("/hardware") ? "Оборудование"
        : pathname.startsWith("/account") ? "Личный кабинет" : "Проекты";

  return (
    <div className={`mag mag-page workspace${graphEditor ? " workspace-graph" : ""}`}>
      <a className="workspace-skip" href="#workspace-content">К содержимому</a>
      <aside className="workspace-sidebar" aria-label="Навигация рабочей среды">
        <Link to="/" className="mag-mark mag-mark-link workspace-brand">
          <i aria-hidden="true">М</i><span>Магистраль <small>ML</small></span>
        </Link>
        <nav className="workspace-nav" aria-label="Рабочая среда">
          <span className="workspace-caption">Рабочая среда</span>
          <NavLink to="/" end className={nav}><span className="workspace-code">ПР</span>Проекты</NavLink>
        </nav>
        {code && <nav className="workspace-nav" aria-label="Разделы проекта">
          <span className="workspace-caption">Текущий проект</span>
          {projectLinks.map(([suffix, label, short]) =>
            <NavLink key={suffix} to={projectPath + suffix} end={!suffix}
              className={suffix === "/training" && pathname.includes("/trainsets/") ? "workspace-link on" : nav}>
              <span className="workspace-code" aria-hidden="true">{short}</span>{label}
            </NavLink>)}
        </nav>}
        <nav className="workspace-nav" aria-label="Инструменты и профиль">
          <span className="workspace-caption">Инструменты</span>
          <NavLink to="/augment" className={nav}><span className="workspace-code">ГР</span>Мои графы</NavLink>
          {me.user.is_staff && <NavLink to="/hardware" className={nav}><span className="workspace-code">GPU</span>Оборудование</NavLink>}
          <NavLink to="/account" className={nav}><span className="workspace-code">ЛК</span>Кабинет</NavLink>
        </nav>
        <div className="workspace-sidebar-foot">Данные <Sep /> разметка <Sep /> обучение</div>
      </aside>
      <header className="mag-topbar workspace-topbar">
        {graphEditor ? <Link to="/augment" className="workspace-project">← Мои графы</Link> : code ? <Link to={projectPath} className="workspace-project" title={code}>{projectName}</Link> : <span className="workspace-project">Рабочая среда</span>}
        <span className="workspace-breadcrumb">{section}</span>
        <Link to="/account" className="mag-me mag-me-link">
          <span className="mag-ava">{initials(me.user.display_name)}</span>
          <span>{me.user.display_name}</span>
        </Link>
      </header>
      <main id="workspace-content" className="workspace-main" tabIndex={-1}>{children}</main>
    </div>
  );
}
