import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  acceptFriend,
  acceptInvitation,
  addFriend,
  changePassword,
  declineInvitation,
  getFriends,
  listInvitations,
  removeFriend,
} from "../../auth/api";
import type { FriendsInfo, InvitationItem } from "../../auth/api";
import { useAuth } from "./AuthGate";

export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join("") || "?"
  );
}

export default function AccountPage() {
  const { me, refresh, signOut } = useAuth();
  const navigate = useNavigate();
  const { user, projects } = me;

  const [friends, setFriends] = useState<FriendsInfo>({
    friends: [],
    incoming: [],
    outgoing: [],
  });
  const [invitations, setInvitations] = useState<InvitationItem[]>([]);
  const [friendIdentity, setFriendIdentity] = useState("");
  const [friendMsg, setFriendMsg] = useState<string | null>(null);
  const [friendErr, setFriendErr] = useState<string | null>(null);

  const [showPass, setShowPass] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [next2, setNext2] = useState("");
  const [passError, setPassError] = useState<string | null>(null);
  const [passOk, setPassOk] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [f, inv] = await Promise.all([getFriends(), listInvitations()]);
      setFriends(f);
      setInvitations(inv);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function handleAddFriend(e: FormEvent) {
    e.preventDefault();
    setFriendMsg(null);
    setFriendErr(null);
    try {
      await addFriend(friendIdentity);
      setFriendMsg("Заявка отправлена.");
      setFriendIdentity("");
      await reload();
    } catch (err) {
      setFriendErr((err as Error).message);
    }
  }

  async function friendAction(action: () => Promise<unknown>) {
    setFriendErr(null);
    try {
      await action();
      await reload();
    } catch (err) {
      setFriendErr((err as Error).message);
    }
  }

  async function handleInvitation(inv: InvitationItem, accept: boolean) {
    try {
      if (accept) {
        const { code } = await acceptInvitation(inv.id);
        await refresh();
        navigate(`/projects/${code}`);
      } else {
        await declineInvitation(inv.id);
        await reload();
      }
    } catch (err) {
      setFriendErr((err as Error).message);
    }
  }

  async function handlePassword(e: FormEvent) {
    e.preventDefault();
    setPassError(null);
    setPassOk(false);
    if (next !== next2) {
      setPassError("Пароли не совпадают.");
      return;
    }
    setBusy(true);
    try {
      await changePassword(current, next);
      setPassOk(true);
      setCurrent("");
      setNext("");
      setNext2("");
      setShowPass(false);
    } catch (err) {
      setPassError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mag-content">
      <div className="mag-cab">
        <div className="mag-card">
          <h3>{user.display_name}</h3>
          <p className="mag-email">{user.email}</p>
          <div className="mag-kv">
            <span>Логин</span>
            <b>{user.login}</b>
          </div>
          <div className="mag-kv">
            <span>Аккаунт создан</span>
            <b>{new Date(user.created_at).toLocaleDateString("ru-RU")}</b>
          </div>
          <div className="mag-kv">
            <span>Проектов</span>
            <b>{projects.length}</b>
          </div>

          {passOk && <div className="mag-ok">Пароль изменён.</div>}
          {!showPass ? (
            <button
              className="mag-ghost"
              type="button"
              onClick={() => {
                setShowPass(true);
                setPassOk(false);
              }}
            >
              Сменить пароль
            </button>
          ) : (
            <form className="mag-pass-form" onSubmit={handlePassword}>
              {passError && <div className="mag-error">{passError}</div>}
              <div className="mag-field">
                <label htmlFor="pw-cur">Текущий пароль</label>
                <input
                  id="pw-cur"
                  type="password"
                  value={current}
                  autoComplete="current-password"
                  onChange={(e) => setCurrent(e.target.value)}
                />
              </div>
              <div className="mag-field">
                <label htmlFor="pw-new">Новый пароль</label>
                <input
                  id="pw-new"
                  type="password"
                  value={next}
                  autoComplete="new-password"
                  onChange={(e) => setNext(e.target.value)}
                />
              </div>
              <div className="mag-field">
                <label htmlFor="pw-new2">Повторите новый пароль</label>
                <input
                  id="pw-new2"
                  type="password"
                  value={next2}
                  autoComplete="new-password"
                  onChange={(e) => setNext2(e.target.value)}
                />
              </div>
              <button className="mag-btn" type="submit" disabled={busy}>
                {busy ? "Сохраняем…" : "Сохранить пароль"}
              </button>
              <button
                className="mag-ghost"
                type="button"
                onClick={() => setShowPass(false)}
              >
                Отмена
              </button>
            </form>
          )}
          <button className="mag-ghost mag-danger" type="button" onClick={signOut}>
            Выйти
          </button>
        </div>

        <div className="mag-cab-main">
          {invitations.length > 0 && (
            <div className="mag-card">
              <h4>Приглашения в проекты</h4>
              {invitations.map((inv) => (
                <div key={inv.id} className="mag-invite-line">
                  <div>
                    <b>{inv.project.name}</b>{" "}
                    <span className="mag-code">{inv.project.code}</span> · роль «
                    {inv.role_label}»
                    {inv.invited_by ? ` · пригласил(а) ${inv.invited_by}` : ""}
                  </div>
                  <div className="mag-invite-actions">
                    <button
                      className="mag-btn mag-btn-sm"
                      type="button"
                      onClick={() => handleInvitation(inv, true)}
                    >
                      Принять
                    </button>
                    <button
                      className="mag-ghost mag-ghost-sm"
                      type="button"
                      onClick={() => handleInvitation(inv, false)}
                    >
                      Отклонить
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mag-card">
            <h4>Друзья</h4>
            {friendErr && <div className="mag-error">{friendErr}</div>}
            {friendMsg && <div className="mag-ok">{friendMsg}</div>}
            <form className="mag-friend-add" onSubmit={handleAddFriend}>
              <input
                type="text"
                placeholder="Логин или почта"
                value={friendIdentity}
                onChange={(e) => setFriendIdentity(e.target.value)}
              />
              <button
                className="mag-btn mag-btn-inline"
                type="submit"
                disabled={!friendIdentity.trim()}
              >
                Добавить в друзья
              </button>
            </form>

            {friends.incoming.map((f) => (
              <div key={f.friendship_id} className="mag-member">
                <span className="mag-ava">{initials(f.user.display_name)}</span>
                <span className="mag-member-name">
                  <b>{f.user.display_name}</b>
                  <span>{f.user.login} · хочет добавить вас в друзья</span>
                </span>
                <span className="mag-invite-actions">
                  <button
                    className="mag-btn mag-btn-sm"
                    type="button"
                    onClick={() => friendAction(() => acceptFriend(f.friendship_id))}
                  >
                    Принять
                  </button>
                  <button
                    className="mag-ghost mag-ghost-sm"
                    type="button"
                    onClick={() => friendAction(() => removeFriend(f.friendship_id))}
                  >
                    Отклонить
                  </button>
                </span>
              </div>
            ))}

            {friends.friends.map((f) => (
              <div key={f.friendship_id} className="mag-member">
                <span className={f.user.online ? "mag-dot on" : "mag-dot off"} />
                <span className="mag-ava">{initials(f.user.display_name)}</span>
                <span className="mag-member-name">
                  <b>{f.user.display_name}</b>
                  <span>
                    {f.user.login} · {f.user.online ? "в сети" : "не в сети"}
                  </span>
                </span>
                <button
                  className="mag-ghost mag-ghost-sm"
                  type="button"
                  onClick={() => friendAction(() => removeFriend(f.friendship_id))}
                >
                  Удалить
                </button>
              </div>
            ))}

            {friends.outgoing.map((f) => (
              <div key={f.friendship_id} className="mag-member">
                <span className="mag-ava">{initials(f.user.display_name)}</span>
                <span className="mag-member-name">
                  <b>{f.user.display_name}</b>
                  <span>{f.user.login} · заявка отправлена</span>
                </span>
                <button
                  className="mag-ghost mag-ghost-sm"
                  type="button"
                  onClick={() => friendAction(() => removeFriend(f.friendship_id))}
                >
                  Отменить
                </button>
              </div>
            ))}

            {friends.friends.length === 0 &&
              friends.incoming.length === 0 &&
              friends.outgoing.length === 0 && (
                <div className="mag-empty">
                  Друзей пока нет. Добавьте коллегу по логину или почте — после
                  принятия заявки его можно звать в проекты одним кликом.
                </div>
              )}
          </div>

          <div className="mag-card">
            <h4>Мои проекты</h4>
            {projects.length === 0 ? (
              <div className="mag-empty">
                Проектов пока нет —{" "}
                <Link to="/" className="mag-link">
                  создайте первый
                </Link>
                .
              </div>
            ) : (
              <div className="mag-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Проект</th>
                      <th>Код</th>
                      <th>Роль</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <Link to={`/projects/${p.code}`} className="mag-link">
                            {p.name}
                          </Link>
                        </td>
                        <td className="mag-code">{p.code}</td>
                        <td>
                          <span className={`mag-role ${p.role}`}>{p.role_label}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
