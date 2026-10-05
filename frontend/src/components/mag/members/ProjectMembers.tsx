// Участники: таблица во всю ширину; роль меняется в строке, приглашения ждут ответа под составом.

import { useState } from "react";
import type { ReactNode } from "react";
import { removeMember, revokeInvitation, setMemberRole } from "../../../auth/api";
import type { ProjectDetail, ProjectMemberInfo } from "../../../auth/api";
import {
  Avatar, Badge, Button, Card, Dialog, Dot, Empty, Input, Notice, PageHeader, Select, Table, cx,
} from "../../../ui";
import { useAuth } from "../../auth/AuthGate";
import { ago, count, ru } from "../../ru";
import { ROLES } from "../FriendPicker";
import type { Role } from "../FriendPicker";
import { useProject } from "../ProjectShell";
import { useAction } from "../classes/useAction";
import { InviteDialog } from "./InviteDialog";
import { day, matchPeople, presence } from "./members";
import type { RoleFilter } from "./members";

type Invite = NonNullable<ProjectDetail["pending_invitations"]>[number];

export default function ProjectMembers() {
  const { detail, refresh } = useProject();
  const { me, refresh: refreshMe } = useAuth();
  const { project, members, my_role } = detail;
  const pending = detail.pending_invitations ?? [];
  const code = project.code;
  const isAdmin = my_role === "admin";
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<RoleFilter>("all");
  const [inviting, setInviting] = useState(false);
  const [kicking, setKicking] = useState<ProjectMemberInfo | null>(null);
  const { busy, error, run, setError } = useAction();

  const people = matchPeople(members.map((m) => ({ user: m, role: m.role })), query, role).map((r) => r.user);
  const invites = matchPeople(pending, query, role);
  const filtered = query.trim() !== "" || role !== "all";
  const online = members.filter((m) => m.online).length;

  const desc = [
    count(members.length, "участник", "участника", "участников"),
    online ? `${ru(online)} в сети` : null,
    pending.length ? `${count(pending.length, "приглашение ждёт", "приглашения ждут", "приглашений ждут")} ответа` : null,
  ].filter(Boolean).join(" · ");

  const changeRole = (m: ProjectMemberInfo, next: Role) => run(async () => {
    await setMemberRole(code, m.id, next);
    await refresh();
    // Своя роль — это ещё и права в шапке и меню
    if (m.id === me.user.id) await refreshMe();
  });

  const roleOptions = [
    { value: "all" as const, label: `Все роли · ${members.length + pending.length}` },
    ...ROLES.map((r) => ({
      value: r.value,
      label: `${r.label} · ${members.filter((m) => m.role === r.value).length + pending.filter((i) => i.role === r.value).length}`,
    })),
  ];

  return (
    <div className="page">
      <PageHeader title="Участники" desc={desc} actions={isAdmin && (
        <Button variant="primary" icon="invite" onClick={() => setInviting(true)}>Пригласить</Button>
      )} />
      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}

      <Card className="mem-card">
        <div className="cls-bar">
          <Input icon="search" type="search" className="cls-q" placeholder="Найти участника" aria-label="Найти участника"
            value={query} onChange={(e) => setQuery(e.target.value)} />
          <Select label="Роль" icon="users" value={role} options={roleOptions} onChange={setRole} />
          {filtered && (
            <span className="t-xs t-faint" role="status">
              {people.length + invites.length} из {members.length + pending.length}
            </span>
          )}
          <span className="grow" />
          <span className="t-xs t-muted">
            {isAdmin ? "Роль меняется сразу — человек увидит новые права при следующем действии"
              : "Состав меняет администратор проекта"}
          </span>
        </div>

        {people.length + invites.length === 0 ? (
          <Empty compact icon="search" title="Никто не подошёл"
            action={<Button size="sm" onClick={() => { setQuery(""); setRole("all"); }}>Сбросить</Button>}>
            Измените запрос или роль.
          </Empty>
        ) : (
          <Table className="mem-tbl">
            <thead>
              <tr>
                <th>Участник</th><th>Роль</th><th className="r">Боксов</th><th>Последняя разметка</th>
                <th>В проекте с</th>{isAdmin && <th aria-label="Действия" />}
              </tr>
            </thead>
            <tbody>
              {people.map((m) => (
                <MemberRow key={m.id} m={m} self={m.id === me.user.id} isAdmin={isAdmin} busy={busy}
                  onRole={(r) => changeRole(m, r)} onKick={() => setKicking(m)} />
              ))}
            </tbody>
            {invites.length > 0 && (
              <tbody>
                <tr className="mem-sub"><td colSpan={isAdmin ? 6 : 5}>Ждут ответа · {invites.length}</td></tr>
                {invites.map((i) => (
                  <InviteRow key={i.id} inv={i} busy={busy}
                    onRevoke={() => run(async () => { await revokeInvitation(code, i.id); await refresh(); })} />
                ))}
              </tbody>
            )}
          </Table>
        )}
      </Card>

      {inviting && (
        <InviteDialog code={code} onClose={() => setInviting(false)} onSent={refresh}
          taken={new Set([...members.map((m) => m.id), ...pending.map((i) => i.user.id)])} />
      )}
      {kicking && (
        <KickDialog m={kicking} onClose={() => setKicking(null)}
          onConfirm={() => {
            const id = kicking.id;
            setKicking(null);
            void run(async () => { await removeMember(code, id); await refresh(); });
          }} />
      )}
    </div>
  );
}

function Who({ name, sub, online, pending }: { name: string; sub: ReactNode; online?: boolean; pending?: boolean }) {
  return (
    <span className={cx("mem-who-c", pending && "pending")}>
      <span className="mem-av">
        <Avatar name={name} size={30} />
        {online && <Dot color="var(--st-done)" title="В сети" />}
      </span>
      <span className="mem-name">
        <b className="t-ell">{name}</b>
        <span className="t-ell">{sub}</span>
      </span>
    </span>
  );
}

function MemberRow({ m, self, isAdmin, busy, onRole, onKick }: {
  m: ProjectMemberInfo;
  self: boolean;
  isAdmin: boolean;
  busy: boolean;
  onRole: (r: Role) => void;
  onKick: () => void;
}) {
  return (
    <tr className={cx(self && "mem-self")}>
      <td>
        <Who name={m.display_name} online={m.online}
          sub={<><span className="ui-mono">{m.login}</span>{self ? " · это вы" : ` · ${presence(m)}`}</>} />
      </td>
      <td>
        {isAdmin ? (
          <Select size="sm" label={`Роль: ${m.display_name}`} value={m.role as Role} options={ROLES}
            disabled={busy} onChange={(r) => { if (r !== m.role) onRole(r); }} />
        ) : (
          <Badge variant="secondary">{m.role_label}</Badge>
        )}
      </td>
      <td className="r ui-mono">{m.boxes ? ru(m.boxes) : <span className="t-faint">—</span>}</td>
      <td className="t-sm">{m.last_box_at ? ago(m.last_box_at) : <span className="t-faint">не размечал(а)</span>}</td>
      <td className="t-sm t-muted">{day(m.joined_at)}</td>
      {isAdmin && (
        <td className="mem-act">
          {/* Себя не исключают — для этого «Выйти из проекта» в меню обзора */}
          {!self && (
            <Button variant="ghost" size="sm" icon="kick" disabled={busy} onClick={onKick}
              aria-label={`Исключить: ${m.display_name}`} title="Исключить из проекта" />
          )}
        </td>
      )}
    </tr>
  );
}

function InviteRow({ inv, busy, onRevoke }: { inv: Invite; busy: boolean; onRevoke: () => void }) {
  return (
    <tr className="mem-inv">
      <td>
        <Who name={inv.user.display_name} pending
          sub={<>{inv.user.login && <span className="ui-mono">{inv.user.login} · </span>}приглашение отправлено {ago(inv.sent_at)}</>} />
      </td>
      <td><Badge variant="outline">{inv.role_label}</Badge></td>
      <td className="r"><span className="t-faint">—</span></td>
      <td />
      <td />
      <td className="mem-act">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onRevoke}>Отозвать</Button>
      </td>
    </tr>
  );
}

function KickDialog({ m, onClose, onConfirm }: { m: ProjectMemberInfo; onClose: () => void; onConfirm: () => void }) {
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }} width={440}
      title={`Исключить: ${m.display_name}`}
      desc="Доступ к проекту пропадёт сразу. Сделанная разметка останется, вернуться можно по новому приглашению."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="danger" icon="kick" onClick={onConfirm} data-autofocus>Исключить</Button>
      </>} />
  );
}
