import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  acceptInvitation,
  declineInvitation,
  listInvitations,
  listProjects,
} from "../../auth/api";
import type { InvitationItem, ProjectSummary } from "../../auth/api";
import { Avatars, Badge, Button, Dot, Empty, Input, Notice, PageHeader, Progress, Seg } from "../../ui";
import { useAuth } from "../auth/AuthGate";
import { pct, ru } from "../ru";
import CreateProjectModal from "./CreateProjectModal";
import { doneShare, projectsLine, runLine } from "./projects";
import type { RunTone } from "./projects";

type RoleFilter = "all" | "admin" | "member";

const TONE: Record<RunTone, string | undefined> = {
  live: "var(--c1)", done: "var(--st-done)", warn: "var(--st-skip)", bad: "var(--destructive)", idle: undefined,
};

const norm = (s: string) => s.toLocaleLowerCase("ru").replace(/ё/g, "е").trim();

/** Все проекты карточками: состояние разметки, обучение и участники видны сразу. */
export default function ProjectsPage() {
  const navigate = useNavigate();
  const { refresh: refreshMe } = useAuth();
  // Приглашение, по которому идёт запрос: второй щелчок по «Принять» слал
  // второй POST, и тот падал на уникальности участника.
  const [answering, setAnswering] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [invitations, setInvitations] = useState<InvitationItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<RoleFilter>("all");

  const refresh = useCallback(async () => {
    try {
      const [p, inv] = await Promise.all([listProjects(), listInvitations()]);
      setProjects(p);
      setInvitations(inv);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const admins = projects.filter((p) => p.role === "admin").length;
  const shown = useMemo(() => {
    const q = norm(query);
    return projects.filter((p) =>
      (role === "all" || (role === "admin") === (p.role === "admin")) &&
      (!q || norm([p.name, p.code, p.description ?? ""].join(" ")).includes(q)));
  }, [projects, query, role]);

  async function answer(inv: InvitationItem, accept: boolean) {
    if (answering) return;
    setAnswering(inv.id);
    setError(null);
    try {
      if (accept) {
        const { code } = await acceptInvitation(inv.id);
        // Шапка и меню узнают о проекте из me — без этого до перезагрузки
        // в шапке стоял код вместо названия.
        await refreshMe();
        navigate(`/projects/${code}`);
      } else {
        await declineInvitation(inv.id);
        await refresh();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAnswering(null);
    }
  }

  const filtering = query.trim() !== "" || role !== "all";

  return (
    <div className="page">
      <PageHeader title="Проекты"
        desc={loaded ? projectsLine(projects, invitations.length) : "Загружаем проекты…"}
        actions={<Button variant="primary" icon="plus" onClick={() => setShowCreate(true)}>Новый проект</Button>} />

      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}

      {loaded && projects.length > 0 && (
        <div className="row between wrap">
          <Seg label="Мои роли" value={role} onChange={setRole} options={[
            { value: "all", label: <>Все <span className="ui-count">{projects.length}</span></> },
            { value: "admin", label: <>Я админ <span className="ui-count">{admins}</span></> },
            { value: "member", label: <>Я участник <span className="ui-count">{projects.length - admins}</span></> },
          ]} />
          <Input icon="search" className="proj-search" placeholder="Найти проект" aria-label="Найти проект"
            type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      )}

      {loaded && projects.length === 0 && invitations.length === 0 ? (
        <Empty icon="folder" title="Проектов пока нет"
          action={<Button variant="primary" icon="plus" onClick={() => setShowCreate(true)}>Новый проект</Button>}>
          Создайте первый проект или дождитесь приглашения — оно появится на этой странице.
        </Empty>
      ) : loaded && shown.length === 0 && filtering ? (
        <Empty icon="search" title="Под условия не подошёл ни один проект"
          action={<Button size="sm" onClick={() => { setQuery(""); setRole("all"); }}>Сбросить</Button>}>
          Поиск идёт по названию, коду и описанию.
        </Empty>
      ) : (
        <div className="grid-cards">
          {shown.map((p) => <ProjectCard key={p.id} p={p} />)}
          {!filtering && invitations.map((inv) => (
            <article key={inv.id} className="ui-card pcard pcard-invite">
              <div className="stack-v">
                <span><Badge variant="secondary" icon="users">Приглашение</Badge></span>
                <h3>{inv.project.name}</h3>
                <p className="t-sm t-muted">
                  {inv.invited_by || "Администратор"} зовёт вас в проект с ролью «{inv.role_label}».
                </p>
              </div>
              <div className="row">
                <Button variant="primary" size="sm" disabled={answering !== null} onClick={() => answer(inv, true)}>
                  Принять
                </Button>
                <Button variant="ghost" size="sm" disabled={answering !== null} onClick={() => answer(inv, false)}>
                  Отклонить
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateProjectModal
          onClose={() => setShowCreate(false)}
          onCreated={async (code) => {
            setShowCreate(false);
            await refreshMe();
            navigate(`/projects/${code}`);
          }}
        />
      )}
    </div>
  );
}

function ProjectCard({ p }: { p: ProjectSummary }) {
  const run = runLine(p.last_run);
  const share = doneShare(p);
  const names = p.members.map((m) => m.display_name);
  // Аватаров приходит пять, остальные участники — только числом
  const all = [...names, ...Array<string>(Math.max(0, p.members_count - names.length)).fill("?")];
  return (
    <Link to={`/projects/${p.code}`} className="ui-card pcard">
      <div className="pcard-h">
        <div className="pcard-t">
          <h3>{p.name}</h3>
          <span className="ui-mono t-xs t-faint">{p.code}</span>
        </div>
        {p.status === "importing"
          ? <Badge tone="var(--c1)" live>Импорт</Badge>
          : <Badge variant={p.role === "admin" ? "secondary" : undefined}>{p.role_label}</Badge>}
      </div>
      <dl className="pstats">
        <div><dt>Кадров</dt><dd>{ru(p.images_count)}</dd></div>
        <div><dt>Классов</dt><dd>{ru(p.classes_count)}</dd></div>
        <div title="Не закрытые таски"><dt>Тасок</dt><dd>{ru(p.tasks_open)}</dd></div>
      </dl>
      <div className="stack-v pcard-done">
        <div className="row between t-sm">
          <span className="t-muted">Размечено</span>
          <span className="ui-mono">{p.images_count ? pct(share) : "—"}</span>
        </div>
        <Progress value={share} label="Размечено" />
      </div>
      <footer className="pcard-f">
        <span className="row">
          <Dot color={TONE[run.tone]} live={run.tone === "live"} />
          <span className="t-ell">{run.text}</span>
        </span>
        <Avatars names={all} max={3} />
      </footer>
    </Link>
  );
}
