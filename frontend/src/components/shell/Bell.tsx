import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { acceptFriend, acceptInvitation, declineInvitation, getFriends, listInvitations } from "../../auth/api";
import type { FriendEntry, InvitationItem } from "../../auth/api";
import { questionInbox } from "../../api/questions";
import type { InboxItem } from "../../api/questions";
import { useAuth } from "../auth/AuthGate";
import { Avatar, Button, Empty, Icon, Popover } from "../../ui";
import { ago } from "../ru";
import { withSep } from "../Sep";

/** Колокольчик: вопросы в тасках, приглашения в проекты и заявки в друзья — то, что ждёт ответа. */
export default function Bell() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [invites, setInvites] = useState<InvitationItem[]>([]);
  const [requests, setRequests] = useState<FriendEntry[]>([]);
  const [inbox, setInbox] = useState<{ items: InboxItem[]; total: number }>({ items: [], total: 0 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // Вопросы — своим запросом: их сбой не гасит приглашения
      const [inv, fr, qi] = await Promise.all([listInvitations(), getFriends(), questionInbox().catch(() => null)]);
      setInvites(inv);
      setRequests(fr.incoming);
      if (qi) setInbox(qi);
    } catch { /* колокольчик молчит, кабинет покажет подробности */ }
  }, []);
  useEffect(() => {
    void load();
    const h = window.setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => window.clearInterval(h);
  }, [load]);

  async function answer(id: string, run: () => Promise<void>) {
    if (busy) return;
    setBusy(id);
    setError(null);
    try { await run(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  // Счёт по показанным: total сервера считает и пункты проектов, из которых ушли
  const n = invites.length + requests.length + inbox.items.length;
  return (
    <Popover align="end" width={340} onOpenChange={(v) => { if (v) void load(); }} trigger={
      <button type="button" className="ui-btn ui-btn-ghost ui-btn-icon bell"
        aria-label={n ? `Ждут ответа: ${n}` : "Уведомлений нет"} title={n ? `Ждут ответа: ${n}` : "Уведомлений нет"}>
        <Icon name="bell" />
        {n > 0 && <span className="bell-n">{n > 9 ? "9+" : n}</span>}
      </button>
    }>
      {(close) => (
        <div className="bell-pop">
          {inbox.items.length > 0 && <div className="ui-pop-h">Вопросы</div>}
          {inbox.items.map((it) => (
            <Link key={it.question_id} className="bell-i bell-q" onClick={close}
              to={`/projects/${it.task.project_code}/tasks/${it.task.id}?q=${it.question_id}`}>
              <span className="bell-qi"><Icon name="question" size={14} /></span>
              <span className="bell-t">
                <b>{it.kind === "new" ? `Вопрос в таске «${it.task.name}»` : "Ответ в обсуждении"}</b>
                <span title={it.text ?? undefined}>{it.author ?? "Без имени"}: {it.text ?? "сообщение удалено"}</span>
                <small>{withSep([ago(it.at), it.kind === "reply" && it.task.name])}</small>
              </span>
            </Link>
          ))}
          {(invites.length + requests.length > 0 || n === 0) && <div className="ui-pop-h">Ждут ответа</div>}
          {error && <p className="ui-hint err" style={{ padding: "0 6px 6px" }}>{error}</p>}
          {n === 0 && <Empty compact title="Новых вопросов, приглашений и заявок нет" />}
          {invites.map((inv) => (
            <div key={inv.id} className="bell-i">
              <div className="bell-t">
                <b>Приглашение в «{inv.project.name}»</b>
                <span>{inv.invited_by ? `${inv.invited_by} зовёт вас` : "Вас зовут"}: {inv.role_label.toLowerCase()}</span>
              </div>
              <div className="row">
                <Button size="sm" variant="primary" disabled={busy === inv.id}
                  onClick={() => answer(inv.id, async () => {
                    const { code } = await acceptInvitation(inv.id);
                    await refresh();
                    close();
                    navigate(`/projects/${code}`);
                  })}>Принять</Button>
                <Button size="sm" variant="ghost" disabled={busy === inv.id}
                  onClick={() => answer(inv.id, async () => { await declineInvitation(inv.id); await load(); })}>
                  Отклонить
                </Button>
              </div>
            </div>
          ))}
          {requests.map((r) => (
            <div key={r.friendship_id} className="bell-i">
              <div className="bell-t bell-who">
                <Avatar name={r.user.display_name} />
                <span><b>{r.user.display_name}</b> хочет добавить вас в друзья</span>
              </div>
              <div className="row">
                <Button size="sm" variant="primary" disabled={busy === r.friendship_id}
                  onClick={() => answer(r.friendship_id, async () => { await acceptFriend(r.friendship_id); await load(); })}>
                  Принять
                </Button>
                <Link className="ui-btn ui-btn-ghost ui-btn-sm" to="/account" onClick={close}>В кабинет</Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </Popover>
  );
}
