import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthGate";
import { initials } from "../auth/AccountPage";

// Light «Магистраль» chrome for the new site: top bar with navigation and the
// user chip. The legacy dark tool at /tools renders without this shell.
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
          <NavLink to="/account" className={nav}>
            Кабинет
          </NavLink>
          <NavLink to="/tools" className={nav}>
            Инструменты
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
