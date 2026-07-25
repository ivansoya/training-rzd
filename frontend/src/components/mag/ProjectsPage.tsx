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

export default function ProjectsPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [invitations, setInvitations] = useState<InvitationItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

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
    setError(null);
    try {
      if (accept) {
        const { code } = await acceptInvitation(inv.id);
        navigate(`/projects/${code}`);
      } else {
        await declineInvitation(inv.id);
        await refresh();
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="mag-content">
      {error && <div className="mag-error">{error}</div>}

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
              onClick={() => handleInvitation(inv, true)}
            >
              Принять
            </button>
            <button
              className="mag-ghost mag-ghost-inline"
              type="button"
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
          Новый проект
        </button>
      </div>

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
          {projects.map((p) => (
            <Link key={p.id} to={`/projects/${p.code}`} className="mag-proj-card">
              <div className="mag-proj-top">
                <h3>{p.name}</h3>
                <span className="mag-code-badge">{p.code}</span>
              </div>
              {p.description && <p className="mag-proj-desc">{p.description}</p>}
              <div className="mag-proj-foot">
                <span className={`mag-role ${p.role}`}>{p.role_label}</span>
                <span className="mag-proj-meta">
                  {p.members_count}{" "}
                  {plural(p.members_count, "участник", "участника", "участников")} ·{" "}
                  {p.datasets_count}{" "}
                  {plural(p.datasets_count, "датасет", "датасета", "датасетов")}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateProjectModal
          onClose={() => setShowCreate(false)}
          onCreated={(code) => {
            setShowCreate(false);
            navigate(`/projects/${code}`);
          }}
        />
      )}
    </div>
  );
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
