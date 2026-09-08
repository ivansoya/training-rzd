import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthGate";
import { initials } from "../auth/AccountPage";

/** Верхняя строка «Магистрали»: продукт, разделы верхнего уровня и человек.
 *
 * Второй уровень — контекст проекта — рисует ProjectShell отдельной строкой
 * под этой. Разделять их важно: продукт не меняется от страницы к странице, а
 * контекст меняется, и мешать их в одну строку значит терять и то, и другое.
 */
export default function MagShell({ children }: { children: ReactNode }) {
  const { me } = useAuth();

  const nav = ({ isActive }: { isActive: boolean }) =>
    isActive ? "mag-nav-link on" : "mag-nav-link";

  return (
    <div className="mag mag-page">
      <div className="mag-topbar">
        <Link to="/" className="mag-mark mag-mark-link">
          <i>М</i> Магистраль ML
        </Link>
        <nav className="mag-topnav">
          <NavLink to="/" end className={nav}>
            Проекты
          </NavLink>
          {/* Аугментации — единственное, что живёт и вне проектов: граф
              принадлежит человеку, а не проекту, и правят его здесь. */}
          <NavLink to="/augment" className={nav}>
            Аугментации
          </NavLink>
          <NavLink to="/account" className={nav}>
            Кабинет
          </NavLink>
        </nav>

        <Link to="/account" className="mag-me mag-me-link">
          <span className="mag-ava">{initials(me.user.display_name)}</span>
          {me.user.display_name}
        </Link>
      </div>
      {children}
    </div>
  );
}
