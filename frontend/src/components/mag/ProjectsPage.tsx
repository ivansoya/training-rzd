import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  acceptInvitation,
  declineInvitation,
  listInvitations,
  listProjects,
} from "../../auth/api";
import type { InvitationItem, ProjectSummary } from "../../auth/api";
import CreateProjectModal from "./CreateProjectModal";
import { initials } from "../auth/AccountPage";
import Banner from "../Banner";
import { plural, ru } from "../ru";
import { useAuth } from "../auth/AuthGate";

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
  const filtered = projects.filter((p) =>
    [p.name, p.code, p.description].join(" ").toLocaleLowerCase("ru").includes(query.trim().toLocaleLowerCase("ru"))
  );

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
    refresh();
  }, [refresh]);

  async function handleInvitation(inv: InvitationItem, accept: boolean) {
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

  return (
    <div className="mag-content">
      {error && <Banner className="mag-error" onClose={() => setError(null)}>{error}</Banner>}

      {invitations.map((inv) => (
        <div key={inv.id} className="mag-invite-banner">
          <div>
            <b>{inv.invited_by || "Администратор"}</b> приглашает вас в проект{" "}
            <b>{inv.project.name}</b>{" "}
            <span className="mag-code">{inv.project.code}</span> — роль «
            {inv.role_label}»
          </div>
          <div className="mag-invite-actions">
            <button
              className="mag-btn mag-btn-inline"
              type="button"
              disabled={answering !== null}
              onClick={() => handleInvitation(inv, true)}
            >
              Принять
            </button>
            <button
              className="mag-ghost mag-ghost-inline"
              type="button"
              disabled={answering !== null}
              onClick={() => handleInvitation(inv, false)}
            >
              Отклонить
            </button>
          </div>
        </div>
      ))}

      <div className="mag-content-head">
        <h1>Проекты</h1>
        <button
          className="mag-btn mag-btn-inline"
          type="button"
          onClick={() => setShowCreate(true)}
        >
          Создать проект
        </button>
      </div>

      {loaded && projects.length > 0 && <div className="workspace-project-search">
        <input type="search" aria-label="Найти проект" placeholder="Название, код или описание…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span role="status">{filtered.length} из {projects.length}</span>
      </div>}
      {!loaded && <div className="mag-card mag-empty" role="status">Загружаем проекты…</div>}
      {loaded && projects.length > 0 && filtered.length === 0 && <div className="mag-card mag-empty-big">
        <h3>Проекты не найдены</h3><p>Попробуйте другое название или код проекта.</p>
        <button type="button" className="mag-ghost mag-ghost-inline" onClick={() => setQuery("")}>Сбросить поиск</button>
      </div>}
      {loaded && projects.length === 0 ? (
        <div className="mag-card mag-empty-big">
          <h3>Проектов пока нет</h3>
          <p>
            Создайте первый проект — или дождитесь приглашения: оно появится на
            этой странице.
          </p>
        </div>
      ) : (
        <div className="mag-projects">
          {filtered.map((p) => (
            <Link key={p.id} to={`/projects/${p.code}`} className="mag-proj-card">
              <div className="mag-proj-top">
                <h3>{p.name}</h3>
                {p.status === "importing" ? (
                  <span className="mag-importing"><i />импорт</span>
                ) : (
                  <span className="mag-code-badge">{p.code}</span>
                )}
              </div>
              {p.description && <p className="mag-proj-desc">{p.description}</p>}

              <div className="mag-proj-nums">
                {(
                  [
                    [p.images_count, "изображение", "изображения", "изображений"],
                    [p.annotations_count, "разметка", "разметки", "разметок"],
                    [p.classes_count, "класс", "класса", "классов"],
                    [p.datasets_count, "датасет", "датасета", "датасетов"],
                  ] as const
                ).map(([n, one, few, many]) => (
                  <div key={many}>
                    <b>{ru(n)}</b>
                    <span>{plural(n, one, few, many)}</span>
                  </div>
                ))}
              </div>

              <div className="mag-proj-foot">
                <span className="mag-faces">
                  {p.members.map((m, i) => (
                    <span
                      key={i}
                      className={m.online ? "mag-ava on" : "mag-ava"}
                      title={m.display_name}
                    >
                      {initials(m.display_name)}
                    </span>
                  ))}
                  {p.members_count > p.members.length && (
                    <span className="mag-ava more">
                      +{p.members_count - p.members.length}
                    </span>
                  )}
                </span>
                <span className={`mag-role ${p.role}`}>{p.role_label}</span>
                <span className="mag-proj-meta">
                  создан {new Date(p.created_at).toLocaleDateString("ru-RU")}
                </span>
              </div>
            </Link>
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

