import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { roleAtLeast, useProjectRole } from "./useProjectRole";
import type { Role } from "./useProjectRole";

const WHO: Record<Role, string> = {
  viewer: "участник проекта",
  editor: "редактор или администратор проекта",
  admin: "администратор проекта",
};

/** Страница действия, на которое нужна роль: без неё — объяснение сразу, а не
 *  пройденный до конца мастер и 403 на последней кнопке. */
export default function RoleGate({ need, what, children }: {
  need: Role; what: string; children: ReactNode;
}) {
  const { code } = useParams<{ code: string }>();
  const role = useProjectRole(code);
  if (roleAtLeast(role, need)) return <>{children}</>;
  return (
    <div className="mag-content mag-empty">
      <p>{what} может {WHO[need]}.</p>
      {code && <Link className="mag-link" to={`/projects/${code}`}>К проекту</Link>}
    </div>
  );
}
