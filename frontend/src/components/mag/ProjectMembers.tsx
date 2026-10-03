import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  updateProject,
  deleteProject,
  getProjectCost,
  inviteToProject,
  removeMember,
  revokeInvitation,
  setMemberRole,
} from "../../auth/api";
import type { ProjectCost } from "../../auth/api";
import { useAuth } from "../auth/AuthGate";
import { useDialog } from "../useDialog";
import { initials } from "../auth/AccountPage";
import { useProject } from "./ProjectShell";
import { count, plural } from "../ru";
import { useEscape } from "./useEscape";
import Sep from "../Sep";
import Banner from "../Banner";

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
  const { me, refresh: refreshMe } = useAuth();
  const navigate = useNavigate();
  const { project, members, my_role, pending_invitations } = detail;
  const [showInvite, setShowInvite] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = my_role === "admin";
  const online = members.filter((m) => m.online).length;

  // Одна обёртка на все правки состава: кнопки гаснут на время запроса
  // (двойной щелчок не шлёт второй), ошибка сервера — словами над списком.
  async function act(action: () => Promise<unknown>, after: () => Promise<unknown> = refresh) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await after();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const leave = () =>
    act(() => removeMember(project.code, me.user.id), async () => {
      await refreshMe();
      navigate("/", { replace: true });
    });

  return (
    <>
      {error && <Banner className="mag-error" onClose={() => setError(null)}>{error}</Banner>}
      <div className="mag-card">
        <div className="mag-card-h">
          <h4>Участники <Sep /> {members.length}</h4>
          {/* Присутствие — не часть состава, а то, что меняется само, пока на
              него смотрят. Внутри заголовка оба числа стояли впритык и
              читались как одно: «12 3 в сети». Здесь это отдельный предмет с
              той же зелёной точкой, что и у людей в списке ниже. */}
          {online > 0 && (
            <span className="mag-presence">
              <i className="mag-dot on" aria-hidden="true" />
              {online} в сети
            </span>
          )}
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
          {members.map((m) => {
            const itself = m.id === me.user.id;
            return (
              <div key={m.id} className="mag-mem">
                <span className={m.online ? "mag-dot on" : "mag-dot"} />
                <span className="mag-ava">{initials(m.display_name)}</span>
                <span className="mag-mem-name">
                  <b>{m.display_name}{itself ? " (вы)" : ""}</b>
                  <span>{m.online ? "в сети" : lastSeenLabel(m.last_seen_at)}</span>
                </span>
                {/* Роль у админа — выбор прямо на карточке, а не отдельное
                    окно: правка в одно действие, как и в окне приглашения. */}
                {isAdmin ? (
                  <span className="mag-mem-admin">
                    <select
                      aria-label={`Роль: ${m.display_name}`}
                      value={m.role}
                      disabled={busy}
                      onChange={(e) => act(() => setMemberRole(project.code, m.id, e.target.value),
                        itself ? async () => { await refresh(); await refreshMe(); } : refresh)}
                    >
                      {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                    {!itself && (
                      <button className="mag-ghost mag-ghost-sm" type="button" disabled={busy}
                        onClick={() => act(() => removeMember(project.code, m.id))}>
                        Исключить
                      </button>
                    )}
                  </span>
                ) : (
                  <span className={`mag-role ${m.role}`}>{m.role_label}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {isAdmin && pending_invitations && pending_invitations.length > 0 && (
        <div className="mag-card">
          <div className="mag-card-h">
            <h4>Ждут ответа <Sep /> {pending_invitations.length}</h4>
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
                <span className="mag-mem-admin">
                  <span className="mag-role">{i.role_label}</span>
                  <button className="mag-ghost mag-ghost-sm" type="button" disabled={busy}
                    onClick={() => act(() => revokeInvitation(project.code, i.id))}>
                    Отозвать
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {isAdmin && (
        <ProjectSettings code={project.code} name={project.name}
          description={project.description} onSaved={async () => { await refresh(); await refreshMe(); }} />
      )}

      <div className="mag-card">
        <div className="mag-card-h">
          <h4>{isAdmin ? "Выход и удаление" : "Выход из проекта"}</h4>
          <span className="mag-invite-actions">
            {confirmLeave ? (
              <>
                <button className="mag-ghost mag-danger mag-ghost-inline" type="button" disabled={busy} onClick={leave}>
                  Подтвердить выход
                </button>
                <button className="mag-ghost mag-ghost-inline" type="button" onClick={() => setConfirmLeave(false)}>
                  Отмена
                </button>
              </>
            ) : (
              <button className="mag-ghost mag-ghost-inline" type="button" onClick={() => setConfirmLeave(true)}>
                Выйти из проекта
              </button>
            )}
            {isAdmin && (
              <button className="mag-ghost mag-danger mag-ghost-inline" type="button"
                onClick={() => setDeleting(true)}>
                Удалить проект
              </button>
            )}
          </span>
        </div>
      </div>

      {deleting && (
        <DeleteProjectModal code={project.code} name={project.name}
          onClose={() => setDeleting(false)} />
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
  const ref = useDialog<HTMLFormElement>();
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
      <form className="mag-modal" ref={ref} role="dialog" aria-modal="true"
        aria-labelledby="inv-title" tabIndex={-1} onSubmit={submit}>
        <h1 id="inv-title">Пригласить в проект</h1>
        <p className="mag-sub">
          Приглашение появится у человека на странице «Проекты» — он решит сам.
        </p>
        {error && <Banner className="mag-error" onClose={() => setError(null)}>{error}</Banner>}

        <div className="mag-field">
          <label htmlFor="inv-id">Логин или почта</label>
          <input
            id="inv-id"
            type="text"
            value={identity}
            placeholder="ivan или ivan@mail.ru"
            maxLength={255}
            onChange={(e) => setIdentity(e.target.value)}
            autoFocus
          />
        </div>

        <div className="mag-field">
          <label id="inv-role">Роль в проекте</label>
          <div className="mag-roles" role="group" aria-labelledby="inv-role">
            {ROLES.map((r) => (
              <button
                key={r.value}
                type="button"
                className={role === r.value ? "mag-role-pick on" : "mag-role-pick"}
                aria-pressed={role === r.value}
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

// Название и описание проекта. Код не меняется: он в ссылках и выгрузках.
function ProjectSettings({ code, name, description, onSaved }: {
  code: string; name: string; description: string | null; onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState({ name, description: description ?? "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft({ name, description: description ?? "" }), [name, description]);
  const changed = draft.name.trim() !== name || draft.description.trim() !== (description ?? "");

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await updateProject(code, { name: draft.name, description: draft.description });
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mag-card" onSubmit={save}>
      <div className="mag-card-h"><h4>Проект</h4></div>
      {error && <Banner className="mag-error" onClose={() => setError(null)}>{error}</Banner>}
      <div className="mag-field">
        <label htmlFor="pr-name">Название</label>
        <input id="pr-name" value={draft.name} maxLength={255}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
      </div>
      <div className="mag-field">
        <label htmlFor="pr-desc">Описание</label>
        <textarea id="pr-desc" rows={3} value={draft.description} maxLength={5000}
          onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />
      </div>
      <button className="mag-btn" type="submit" disabled={busy || !changed || !draft.name.trim()}>
        {busy ? "Сохраняем…" : "Сохранить"}
      </button>
    </form>
  );
}

// Удаление необратимо, поэтому окно сначала называет цену — сколько кадров,
// разметки, наборов и обучений уйдёт, — и просит набрать название проекта.
// Простого «Вы уверены?» мало: на него жмут, не читая.
function DeleteProjectModal({ code, name, onClose }: { code: string; name: string; onClose: () => void }) {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [cost, setCost] = useState<ProjectCost | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useDialog<HTMLFormElement>();
  useEscape(onClose);

  useEffect(() => {
    getProjectCost(code).then(setCost).catch((e) => setError((e as Error).message));
  }, [code]);

  async function run(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await deleteProject(code);
      await refresh();
      navigate("/", { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const ready = cost !== null && !cost.busy && typed.trim() === name.trim() && !busy;
  return (
    <div className="mag-backdrop">
      <form className="mag-modal" ref={ref}
        role="dialog" aria-modal="true" aria-labelledby="del-title" tabIndex={-1} onSubmit={run}>
        <h1 id="del-title">Удалить проект «{name}»</h1>
        {error && <Banner className="mag-error" onClose={() => setError(null)}>{error}</Banner>}
        {cost === null ? (
          !error && <p className="mag-sub">Считаем, что уйдёт…</p>
        ) : (
          <>
            <p className="mag-sub">
              Вместе с проектом безвозвратно уйдут {count(cost.images, "кадр", "кадра", "кадров")},{" "}
              {count(cost.annotations, "разметка", "разметки", "разметок")},{" "}
              {count(cost.tasks, "таска", "таски", "тасок")},{" "}
              {count(cost.train_sets, "обучающий набор", "обучающих набора", "обучающих наборов")} и{" "}
              {count(cost.train_runs, "обучение", "обучения", "обучений")} с весами.
            </p>
            {cost.busy && (
              <div className="mag-error">Сейчас в проекте {cost.busy}. Дождитесь окончания или остановите работу.</div>
            )}
          </>
        )}
        <div className="mag-field">
          <label htmlFor="del-name">Введите название проекта</label>
          <input id="del-name" type="text" value={typed} autoComplete="off" placeholder={name}
            onChange={(e) => setTyped(e.target.value)} />
        </div>
        <div className="mag-modal-foot">
          <button className="mag-ghost" type="button" onClick={onClose}>Отмена</button>
          <button className="mag-btn mag-danger" type="submit" disabled={!ready}>
            {busy ? "Удаляем…" : "Удалить навсегда"}
          </button>
        </div>
      </form>
    </div>
  );
}
