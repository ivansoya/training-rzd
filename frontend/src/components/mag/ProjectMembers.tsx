import { useState } from "react";
import type { FormEvent } from "react";
import { inviteToProject } from "../../auth/api";
import { initials } from "../auth/AccountPage";
import { useProject } from "./ProjectShell";
import { plural } from "./ProjectsPage";
import { useEscape } from "./useEscape";

const ROLES = [
  { value: "viewer", label: "Просмотр", hint: "Смотрит данные и статистику, ничего не меняет." },
  { value: "editor", label: "Редактор", hint: "Размечает изображения и правит классы проекта." },
  { value: "admin", label: "Администратор", hint: "Всё то же плюс импорт данных и приглашения." },
];

function lastSeenLabel(iso: string | null | undefined): string {
  if (!iso) return "не заходил(а)";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `был(а) ${Math.max(mins, 1)} мин назад`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `был(а) ${hours} ч назад`;
  const days = Math.floor(hours / 24);
  return `был(а) ${days} ${plural(days, "день", "дня", "дней")} назад`;
}

export default function ProjectMembers() {
  const { detail, refresh } = useProject();
  const { project, members, my_role, pending_invitations } = detail;
  const [showInvite, setShowInvite] = useState(false);
  const isAdmin = my_role === "admin";
  const online = members.filter((m) => m.online).length;

  return (
    <>
      <div className="mag-card">
        <div className="mag-card-h">
          <h4>
            Участники · {members.length}
            {online > 0 && <span className="mag-online-n"> {online} в сети</span>}
          </h4>
          {isAdmin && (
            <button
              className="mag-btn mag-btn-inline"
              type="button"
              onClick={() => setShowInvite(true)}
            >
              Пригласить
            </button>
          )}
        </div>

        <div className="mag-members">
          {members.map((m) => (
            <div key={m.id} className="mag-mem">
              <span className={m.online ? "mag-dot on" : "mag-dot"} />
              <span className="mag-ava">{initials(m.display_name)}</span>
              <span className="mag-mem-name">
                <b>{m.display_name}</b>
                <span>{m.online ? "в сети" : lastSeenLabel(m.last_seen_at)}</span>
              </span>
              <span className={`mag-role ${m.role}`}>{m.role_label}</span>
            </div>
          ))}
        </div>
      </div>

      {isAdmin && pending_invitations && pending_invitations.length > 0 && (
        <div className="mag-card">
          <div className="mag-card-h">
            <h4>Ждут ответа · {pending_invitations.length}</h4>
          </div>
          <div className="mag-members">
            {pending_invitations.map((i) => (
              <div key={i.id} className="mag-mem pending">
                <span className="mag-dot" />
                <span className="mag-ava">{initials(i.user.display_name)}</span>
                <span className="mag-mem-name">
                  <b>{i.user.display_name}</b>
                  <span>приглашение отправлено</span>
                </span>
                <span className="mag-role">{i.role_label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {showInvite && (
        <InviteModal
          code={project.code}
          onClose={() => setShowInvite(false)}
          onDone={async () => {
            setShowInvite(false);
            await refresh();
          }}
        />
      )}
    </>
  );
}

function InviteModal({
  code,
  onClose,
  onDone,
}: {
  code: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [identity, setIdentity] = useState("");
  const [role, setRole] = useState("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscape(onClose);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await inviteToProject(code, identity.trim(), role);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mag-backdrop">
      <form className="mag-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h1>Пригласить в проект</h1>
        <p className="mag-sub">
          Приглашение появится у человека на странице «Проекты» — он решит сам.
        </p>
        {error && <div className="mag-error">{error}</div>}

        <div className="mag-field">
          <label htmlFor="inv-id">Логин или почта</label>
          <input
            id="inv-id"
            type="text"
            value={identity}
            placeholder="ivan или ivan@mail.ru"
            onChange={(e) => setIdentity(e.target.value)}
            autoFocus
          />
        </div>

        <div className="mag-field">
          <label>Роль в проекте</label>
          <div className="mag-roles">
            {ROLES.map((r) => (
              <button
                key={r.value}
                type="button"
                className={role === r.value ? "mag-role-pick on" : "mag-role-pick"}
                onClick={() => setRole(r.value)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <p className="mag-role-hint">
            {ROLES.find((r) => r.value === role)?.hint}
          </p>
        </div>

        <div className="mag-modal-foot">
          <button className="mag-ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="mag-btn" type="submit" disabled={busy || !identity.trim()}>
            Отправить приглашение
          </button>
        </div>
      </form>
    </div>
  );
}
