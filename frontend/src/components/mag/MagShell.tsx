import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Link, NavLink, matchPath, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthGate";
import { initials } from "../auth/AccountPage";
import Sep from "../Sep";
import ErrorBoundary from "../ErrorBoundary";

/** The workspace shell never transforms its children: editors measure their
 * bitmap and annotation layers in viewport coordinates. */
export default function MagShell({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const { pathname } = useLocation();
  const graphEditor = Boolean(matchPath("/augment/:graphId", pathname));
  const agentEditor = Boolean(matchPath("/agents/:graphId", pathname));
  // Текущий проект — только тот, где мы участник, и без учёта регистра: сервер
  // принимает код строчными. Раньше /projects/NOPE и /projects/%20 рисовали блок
  // «Текущий проект» и сырой код в шапке, а код строчными — код вместо имени.
  const rawCode = matchPath("/projects/:code/*", pathname)?.params.code;
  const current = rawCode
    ? me.projects.find((p) => p.code === rawCode.trim().toUpperCase())
    : undefined;
  const code = current?.code;
  const projectPath = code ? "/projects/" + code : "";
  const projectName = current?.name;
  const lowerPath = pathname.toLowerCase();
  const nav = ({ isActive }: { isActive: boolean }) =>
    isActive ? "workspace-link on" : "workspace-link";
  const projectLinks = [
    ["", "Обзор", "ОБ"], ["/tasks", "Таски", "ТС"],
    ["/datasets", "Датасеты", "ДТ"], ["/classes", "Классы", "КЛ"],
    ["/tags", "Таги", "ТГ"],
    ["/aug", "Аугментации проекта", "АУ"], ["/training", "Обучение", "МО"],
    ["/members", "Участники", "УЧ"],
  ];
  const section = code
    ? projectLinks.find(([suffix]) => suffix && lowerPath.startsWith((projectPath + suffix).toLowerCase()))?.[1]
      ?? (pathname.includes("/trainsets/") ? "Обучающий набор" : pathname.endsWith("/import") ? "Импорт" : "Обзор проекта")
    : pathname.startsWith("/augment") ? "Библиотека аугментаций"
      : pathname.startsWith("/agents") ? "Агенты разметки"
      : pathname.startsWith("/hardware") ? "Оборудование"
        : pathname.startsWith("/account") ? "Личный кабинет" : "Проекты";

  useEffect(() => {
    document.title = [projectName, section, "Магистраль"].filter(Boolean).join(" — ");
  }, [projectName, section]);

  // На узком экране меню — горизонтальная лента, и активный пункт уезжал за
  // край. Двигаем только ленту: scrollIntoView прокрутил бы ещё и страницу.
  const sidebar = useRef<HTMLElement>(null);
  useEffect(() => {
    const bar = sidebar.current;
    const on = bar?.querySelector<HTMLElement>(".workspace-link.on");
    if (!bar || !on || bar.scrollWidth <= bar.clientWidth) return;
    const b = bar.getBoundingClientRect();
    const r = on.getBoundingClientRect();
    if (r.left < b.left || r.right > b.right) bar.scrollLeft += r.left - b.left - (b.width - r.width) / 2;
  }, [pathname, code]);

  return (
    <div className={`mag mag-page workspace${graphEditor || agentEditor ? " workspace-graph" : ""}`}>
      <a className="workspace-skip" href="#workspace-content">К содержимому</a>
      <aside ref={sidebar} className="workspace-sidebar" aria-label="Навигация рабочей среды">
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
          <NavLink to="/agents" className={nav}><span className="workspace-code">АГ</span>Мои агенты</NavLink>
          {/* Всем, а не только обслуживанию: свою очередь к картам видит каждый,
              и без пункта меню ожидание обучения было нечем объяснить. */}
          <NavLink to="/hardware" className={nav}><span className="workspace-code">GPU</span>Оборудование</NavLink>
          <NavLink to="/account" className={nav}><span className="workspace-code">ЛК</span>Кабинет</NavLink>
        </nav>
        <div className="workspace-sidebar-foot">Данные <Sep /> разметка <Sep /> обучение</div>
      </aside>
      <header className="mag-topbar workspace-topbar">
        {graphEditor ? <Link to="/augment" className="workspace-project">← Мои графы</Link> : agentEditor ? <Link to="/agents" className="workspace-project">← Мои агенты</Link> : code ? <Link to={projectPath} className="workspace-project" title={projectName}>{projectName}</Link> : <span className="workspace-project">Рабочая среда</span>}
        <span className="workspace-breadcrumb">{section}</span>
        <Link to="/account" className="mag-me mag-me-link">
          <span className="mag-ava">{initials(me.user.display_name)}</span>
          <span>{me.user.display_name}</span>
        </Link>
      </header>
      <main id="workspace-content" className="workspace-main" tabIndex={-1}>
        <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
      </main>
    </div>
  );
}
