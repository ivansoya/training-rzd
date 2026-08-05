import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, createProject, getFriends } from "../../auth/api";
import type { FriendEntry } from "../../auth/api";
import { initials } from "../auth/AccountPage";
import { useEscape } from "./useEscape";

interface Props {
  onClose: () => void;
  onCreated: (code: string) => void;
}

interface Pick {
  checked: boolean;
  role: string;
}

export default function CreateProjectModal({ onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [friends, setFriends] = useState<FriendEntry[]>([]);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [nudge, setNudge] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getFriends()
      .then((f) => setFriends(f.friends))
      .catch(() => {});
  }, []);

  useEscape(onClose);

  // Клик мимо модалки больше не закрывает её — слишком легко потерять набранное.
  // Вместо этого показываем, чего не хватает; всё заполнено — просто дёргаем.
  function handleBackdrop() {
    if (!name.trim()) {
      setFieldErrors((prev) => ({ ...prev, name: "Укажите название проекта." }));
      nameRef.current?.focus();
      return;
    }
    setNudge(true);
    window.setTimeout(() => setNudge(false), 400);
  }

  const visibleFriends = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return friends;
    return friends.filter(
      (f) =>
        f.user.display_name.toLowerCase().includes(q) ||
        f.user.login.toLowerCase().includes(q)
    );
  }, [friends, filter]);

  const selectedCount = Object.values(picks).filter((p) => p.checked).length;

  function setPick(userId: string, patch: Partial<Pick>) {
    setPicks((prev) => {
      const base = prev[userId] ?? { checked: false, role: "editor" };
      return { ...prev, [userId]: { ...base, ...patch } };
    });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setBusy(true);
    try {
      const invites = Object.entries(picks)
        .filter(([, p]) => p.checked)
        .map(([user_id, p]) => ({ user_id, role: p.role }));
      const { code: created } = await createProject({ name, description, invites });
      onCreated(created);
    } catch (err) {
      if (err instanceof ApiError && err.fields) setFieldErrors(err.fields);
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mag-backdrop" onClick={handleBackdrop}>
      <form
        className={
          nudge
            ? "mag-modal mag-modal-2col mag-modal-nudge"
            : "mag-modal mag-modal-2col"
        }
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="mag-modal-left">
          <h1>Новый проект</h1>
          <p className="mag-sub">
            Код проекта присвоится автоматически. Датасет загрузим на странице
            проекта.
          </p>
          {error && <div className="mag-error">{error}</div>}
          <div className={fieldErrors.name ? "mag-field invalid" : "mag-field"}>
            <label htmlFor="np-name">Название</label>
            <input
              id="np-name"
              type="text"
              ref={nameRef}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                // Подсветка гаснет, как только человек начал отвечать на неё.
                if (fieldErrors.name) {
                  setFieldErrors(({ name: _drop, ...rest }) => rest);
                }
              }}
            />
            {fieldErrors.name && (
              <div className="mag-field-error">{fieldErrors.name}</div>
            )}
          </div>
          <div className="mag-field">
            <label htmlFor="np-desc">Описание</label>
            <textarea
              id="np-desc"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>

        <div className="mag-modal-right">
          <h3>Пригласить участников</h3>
          <p className="mag-sub">
            Из друзей — одним кликом. Остальных пригласите по логину со
            страницы проекта.
          </p>
          <div className="mag-field">
            <input
              type="text"
              placeholder="Поиск по друзьям…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="mag-modal-friends">
            {friends.length === 0 && (
              <div className="mag-empty">
                Список друзей пуст — добавьте друзей в кабинете, чтобы звать их
                в проекты одним кликом.
              </div>
            )}
            {visibleFriends.map((f) => {
              const pick = picks[f.user.id];
              return (
                <label key={f.user.id} className="mag-friend-row">
                  <input
                    type="checkbox"
                    checked={pick?.checked || false}
                    onChange={(e) => setPick(f.user.id, { checked: e.target.checked })}
                  />
                  <span className="mag-ava">{initials(f.user.display_name)}</span>
                  <span className="mag-friend-name">
                    <b>{f.user.display_name}</b>
                    <span>{f.user.login} · друг</span>
                  </span>
                  <select
                    value={pick?.role || "editor"}
                    disabled={!pick?.checked}
                    onChange={(e) => setPick(f.user.id, { role: e.target.value })}
                  >
                    <option value="editor">Редактор</option>
                    <option value="admin">Администратор</option>
                    <option value="viewer">Просмотр</option>
                  </select>
                </label>
              );
            })}
          </div>
        </div>

        <div className="mag-modal-foot">
          <button className="mag-ghost mag-ghost-inline" type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="mag-btn mag-btn-inline" type="submit" disabled={busy}>
            {busy
              ? "Создаём…"
              : selectedCount > 0
                ? `Создать и пригласить (${selectedCount})`
                : "Создать проект"}
          </button>
        </div>
      </form>
    </div>
  );
}
