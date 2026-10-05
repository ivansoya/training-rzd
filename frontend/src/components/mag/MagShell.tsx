import { Fragment, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, matchPath, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthGate";
import ErrorBoundary from "../ErrorBoundary";
import { LiveProvider } from "../../live/LiveProvider";
import { Avatar, Empty, Icon, LinkButton, MenuItem, Popover, RailsMark, cx } from "../../ui";
import Bell from "../shell/Bell";
import GpuMeter from "../shell/GpuMeter";
import MeMenu from "../shell/MeMenu";
import SearchBox from "../shell/SearchBox";
import { PROJECT_GROUPS, hrefOf, sectionOf } from "../shell/nav";
import type { NavItem } from "../shell/nav";

const LAST = "mag.lastProject";
const readLast = () => { try { return localStorage.getItem(LAST); } catch { return null; } };
const writeLast = (code: string) => { try { localStorage.setItem(LAST, code); } catch { /* приватное окно */ } };

/** Каркас никогда не трансформирует детей: редакторы меряют слои в координатах окна. */
/** «№14» по адресу прогона; uuid старой ссылки — просто «Прогон», пока страница не подменит адрес. */
const runCrumb = (id: string | undefined) => (id && /^\d+$/.test(id) ? `№${id}` : "Обучение");

export default function MagShell({ children }: { children: ReactNode }) {
  const { me, refresh } = useAuth();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  // Текущий проект — только тот, где мы участник, без учёта регистра кода.
  const rawCode = matchPath("/projects/:code/*", pathname)?.params.code;
  const current = rawCode
    ? me.projects.find((p) => p.code === rawCode.trim().toUpperCase())
    : undefined;
  const code = current?.code;
  // Не участник — «не найден», но сначала один раз перечитываем себя: проект могли только что создать.
  const [checked, setChecked] = useState<string | null>(null);
  const missing = Boolean(rawCode) && !current;
  useEffect(() => {
    if (!missing || checked === rawCode) return;
    refresh().catch(() => undefined).finally(() => setChecked(rawCode ?? null));
  }, [missing, rawCode, checked, refresh]);

  // Вне проекта сайдбар держит последний открытый — из агента назад к таскам одним щелчком.
  useEffect(() => { if (code) writeLast(code); }, [code]);
  const last = me.projects.find((p) => p.code === readLast());
  const project = current ?? last ?? (me.projects.length === 1 ? me.projects[0] : undefined);

  const section = sectionOf(pathname, search, code);
  useEffect(() => {
    document.title = [current?.name, section.label, "Магистраль"].filter(Boolean).join(" — ");
  }, [current?.name, section.label]);

  const active = section.key === "graphs" && project ? "aug" : section.key;
  const groups = project ? PROJECT_GROUPS : [{
    title: "Подготовка",
    items: [
      { key: "graphs", label: "Мои графы", icon: "workflow", to: "/augment", abs: true },
      { key: "agents", label: "Мои агенты", icon: "sparkle", to: "/agents", abs: true },
    ] as NavItem[],
  }];
  const roleOf = current ?? project;

  const shell = (
    <div className="mag shell">
      <a className="shell-skip" href="#workspace-content">К содержимому</a>
      <aside className="sb" aria-label="Навигация">
        <Popover align="start" width={232} trigger={
          <button type="button" className="sb-proj" aria-label="Сменить проект">
            <span className="sb-logo"><RailsMark /></span>
            <span className="sb-proj-t">
              <b>{project?.name ?? "Магистраль ML"}</b>
              <span>{project ? `${project.code} · ${project.role_label.toLowerCase()}` : "проект не выбран"}</span>
            </span>
            <Icon name="updown" size={14} />
          </button>
        }>
          {(close) => (
            <>
              <div className="ui-pop-h">Проекты</div>
              {me.projects.map((p) => (
                <MenuItem key={p.code} selected={p.code === project?.code} hint={`${p.code} · ${p.role_label.toLowerCase()}`}
                  onSelect={() => { close(); navigate(`/projects/${p.code}`); }}>
                  {p.name}
                </MenuItem>
              ))}
              {me.projects.length > 0 && <div className="ui-pop-sep" />}
              <MenuItem icon="folder" onSelect={() => { close(); navigate("/"); }}>Все проекты</MenuItem>
            </>
          )}
        </Popover>

        <nav className="sb-nav" aria-label="Разделы">
          <Link to="/" className={cx("nv", active === "projects" && "on")}
            aria-current={active === "projects" ? "page" : undefined}>
            <Icon name="folder" /><span>Все проекты</span>
            {me.projects.length > 0 && <span className="ui-count">{me.projects.length}</span>}
          </Link>
          {groups.map((g) => (
            <Fragment key={g.title}>
              <div className="nv-g">{g.title}</div>
              {g.items.map((it) => (
                <Link key={it.key} to={hrefOf(it, project?.code ?? "")}
                  className={cx("nv", active === it.key && "on")}
                  aria-current={active === it.key ? "page" : undefined}>
                  <Icon name={it.icon} /><span>{it.label}</span>
                </Link>
              ))}
            </Fragment>
          ))}
        </nav>

        <div className="sb-f">
          <GpuMeter />
          {/* Всем, а не только обслуживанию: свою очередь к картам видит каждый. */}
          <Link to="/hardware" className={cx("nv", active === "hardware" && "on")}
            aria-current={active === "hardware" ? "page" : undefined}>
            <Icon name="cpu" /><span>Оборудование</span>
          </Link>
          <Link to="/account" className={cx("sb-me", active === "account" && "on")} title="Личный кабинет">
            <Avatar name={me.user.display_name} size={28} />
            <span className="sb-me-t">
              <span>{me.user.display_name}</span>
              <span>{roleOf ? roleOf.role_label.toLowerCase() : me.user.login}</span>
            </span>
          </Link>
        </div>
      </aside>

      <div className="shell-main">
        <header className="topbar">
          <nav className="crumbs" aria-label="Путь">
            {current ? (
              <>
                <Link to="/">Проекты</Link>
                <Icon name="chevR" size={14} />
                {section.key === "overview" && section.label === "Обзор"
                  ? <b>{current.name}</b>
                  : matchPath("/projects/:code/runs/:runId", pathname)
                    ? <><Link to={`/projects/${current.code}`}>{current.name}</Link>
                      <Icon name="chevR" size={14} /><Link to={`/projects/${current.code}/runs`}>{section.label}</Link>
                      <Icon name="chevR" size={14} /><b>{runCrumb(matchPath("/projects/:code/runs/:runId", pathname)?.params.runId)}</b></>
                  : matchPath("/projects/:code/tasks/:taskId", pathname)
                    ? <><Link to={`/projects/${current.code}`}>{current.name}</Link>
                      <Icon name="chevR" size={14} /><Link to={`/projects/${current.code}/tasks`}>{section.label}</Link>
                      <Icon name="chevR" size={14} /><b>Таска</b></>
                    : <><Link to={`/projects/${current.code}`}>{current.name}</Link>
                      <Icon name="chevR" size={14} /><b>{section.label}</b></>}
              </>
            ) : matchPath("/augment/:id", pathname) ? (
              <><Link to="/augment">Мои графы</Link><Icon name="chevR" size={14} /><b>Граф</b></>
            ) : matchPath("/agents/:id", pathname) ? (
              <><Link to="/agents">Мои агенты</Link><Icon name="chevR" size={14} /><b>Агент</b></>
            ) : <b>{section.label}</b>}
          </nav>
          <span className="grow" />
          <SearchBox projects={me.projects} project={project} />
          <Bell />
          <MeMenu />
        </header>
        <main id="workspace-content" className="shell-content" tabIndex={-1}>
          <ErrorBoundary resetKey={pathname}>
            {!missing ? children : checked === rawCode ? (
              <div className="page">
                <Empty icon="folder" title="Проект не найден или у вас нет к нему доступа."
                  action={<LinkButton to="/" icon="back">К проектам</LinkButton>} />
              </div>
            ) : (
              <div className="page"><Empty compact title="Загружаем проект…" /></div>
            )}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
  // Живая связь — одна на вкладку и на весь проект, на любой его странице.
  return code ? <LiveProvider key={code} code={code}>{shell}</LiveProvider> : shell;
}
