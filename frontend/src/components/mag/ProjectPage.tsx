import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { getProject, inviteToProject } from "../../auth/api";
import type { ProjectDetail } from "../../auth/api";
import { initials } from "../auth/AccountPage";
import { plural } from "./ProjectsPage";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  const units = ["КБ", "МБ", "ГБ", "ТБ"];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ${units[i]}`;
}

function lastSeenLabel(iso: string | null | undefined): string {
  if (!iso) return "не заходил(а)";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `был(а) ${Math.max(mins, 1)} мин назад`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `был(а) ${hours} ч назад`;
  const days = Math.floor(hours / 24);
  return `был(а) ${days} ${plural(days, "день", "дня", "дней")} назад`;
}

// Согласованная компоновка П2 «Паспорт слева»: колонка-паспорт проекта и
// участники слева, статистика и датасеты справа.
export default function ProjectPage() {
  const { code } = useParams<{ code: string }>();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [inviteIdentity, setInviteIdentity] = useState("");
  const [inviteRole, setInviteRole] = useState("editor");
  const [inviteMsg, setInviteMsg] = useState<string | null>(null);
  const [inviteErr, setInviteErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!code) return;
    try {
      setDetail(await getProject(code));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [code]);

  useEffect(() => {
    refresh();
    // Онлайн-статусы участников обновляются раз в 30 секунд.
    const h = setInterval(refresh, 30_000);
    return () => clearInterval(h);
  }, [refresh]);

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    setInviteMsg(null);
    setInviteErr(null);
    setBusy(true);
    try {
      await inviteToProject(code!, inviteIdentity, inviteRole);
      setInviteMsg("Приглашение отправлено.");
      setInviteIdentity("");
      await refresh();
    } catch (err) {
      setInviteErr((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="mag-content">
        <div className="mag-error">{error}</div>
        <Link to="/" className="mag-link">
          ← К списку проектов
        </Link>
      </div>
    );
  }
  if (!detail) {
    return <div className="mag-content mag-empty">Загружаем проект…</div>;
  }

  const { project, stats, members, datasets, classes, my_role } = detail;
  const online = members.filter((m) => m.online).length;
  const isAdmin = my_role === "admin";

  return (
    <div className="mag-content">
      <div className="mag-crumbs">
        <Link to="/">Проекты</Link> / <b>{project.name}</b>
      </div>
      <div className="mag-pp">
        <div className="mag-card mag-pass">
          <span className="mag-code-badge">{project.code}</span>
          <h1>{project.name}</h1>
          {project.description && (
            <p className="mag-pass-desc">{project.description}</p>
          )}
          <div className="mag-kv">
            <span>Создан</span>
            <b>
              {new Date(project.created_at).toLocaleDateString("ru-RU")}
              {project.created_by ? ` · ${project.created_by}` : ""}
            </b>
          </div>
          <div className="mag-kv">
            <span>Датасетов</span>
            <b>{stats.datasets}</b>
          </div>
          <div className="mag-kv">
            <span>Место на сервере</span>
            <b>{formatBytes(stats.size_bytes)}</b>
          </div>

          <div className="mag-pass-sect">
            Участники · {online} {plural(online, "в сети", "в сети", "в сети")}
          </div>
          {members.map((m) => (
            <div key={m.id} className="mag-member">
              <span className={m.online ? "mag-dot on" : "mag-dot off"} />
              <span className="mag-ava">{initials(m.display_name)}</span>
              <span className="mag-member-name">
                <b>{m.display_name}</b>
                <span>{m.online ? "в сети" : lastSeenLabel(m.last_seen_at)}</span>
              </span>
              <span className={`mag-role ${m.role}`}>{m.role_label}</span>
            </div>
          ))}

          {isAdmin && (
            <form className="mag-pass-invite" onSubmit={handleInvite}>
              {inviteMsg && <div className="mag-ok">{inviteMsg}</div>}
              {inviteErr && <div className="mag-error">{inviteErr}</div>}
              <div className="mag-field">
                <label htmlFor="pp-inv">Пригласить участника</label>
                <input
                  id="pp-inv"
                  type="text"
                  placeholder="Логин или почта"
                  value={inviteIdentity}
                  onChange={(e) => setInviteIdentity(e.target.value)}
                />
              </div>
              <div className="mag-invite-row">
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  aria-label="Роль"
                >
                  <option value="editor">Редактор</option>
                  <option value="admin">Администратор</option>
                  <option value="viewer">Просмотр</option>
                </select>
                <button
                  className="mag-btn mag-btn-inline"
                  type="submit"
                  disabled={busy || !inviteIdentity.trim()}
                >
                  Пригласить
                </button>
              </div>
              {detail.pending_invitations && detail.pending_invitations.length > 0 && (
                <div className="mag-pending">
                  {detail.pending_invitations.map((i) => (
                    <div key={i.id}>
                      {i.user.display_name} · {i.role_label} — ждёт ответа
                    </div>
                  ))}
                </div>
              )}
            </form>
          )}
        </div>

        <div className="mag-pp-main">
          <div className="mag-statrow">
            <div className="mag-stat">
              <b>{stats.annotations.toLocaleString("ru-RU")}</b>
              <span>разметок</span>
            </div>
            <div className="mag-stat">
              <b>{stats.images.toLocaleString("ru-RU")}</b>
              <span>изображений</span>
            </div>
            <div className="mag-stat">
              <b>{stats.classes}</b>
              <span>
                {plural(stats.classes, "класс", "класса", "классов")}
              </span>
            </div>
          </div>

          <div className="mag-card">
            <h4>Датасеты</h4>
            {datasets.length === 0 ? (
              <div className="mag-empty">
                В базе проекта датасетов пока нет. Файловые датасеты старого
                приложения живут в{" "}
                <Link to="/tools" className="mag-link">
                  Инструментах
                </Link>{" "}
                — миграция в проекты будет следующим шагом.
              </div>
            ) : (
              <div className="mag-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Название</th>
                      <th>Идентификатор</th>
                      <th>Изображений</th>
                      <th>Создан</th>
                    </tr>
                  </thead>
                  <tbody>
                    {datasets.map((d) => (
                      <tr key={d.id}>
                        <td>{d.name}</td>
                        <td className="mag-code">{d.identifier}</td>
                        <td>{d.images_count.toLocaleString("ru-RU")}</td>
                        <td>{new Date(d.created_at).toLocaleDateString("ru-RU")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="mag-card">
            <h4>Разметки по классам</h4>
            {classes.length === 0 ? (
              <div className="mag-empty">
                Классы появятся вместе с первым датасетом и разметкой.
              </div>
            ) : (
              classes.map((c) => (
                <div key={c.name} className="mag-cls">
                  <i style={{ background: c.color }} />
                  {c.name}
                  <span className="mag-cls-n">
                    {c.annotations.toLocaleString("ru-RU")}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
