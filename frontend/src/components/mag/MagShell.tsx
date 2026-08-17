import { useState } from "react";
import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { applyTheme, readTheme } from "../../theme";
import type { Theme } from "../../theme";
import { useAuth } from "../auth/AuthGate";
import { initials } from "../auth/AccountPage";

const THEMES: { id: Theme; label: string; hint: string }[] = [
  { id: "light", label: "☀", hint: "Светлая тема" },
  { id: "dark", label: "☾", hint: "Тёмная тема" },
  { id: "system", label: "◐", hint: "Как в системе" },
];

/** Верхняя строка «Магистрали»: продукт, разделы верхнего уровня и человек.
 *
 * Второй уровень — контекст проекта — рисует ProjectShell отдельной строкой
 * под этой. Разделять их важно: продукт не меняется от страницы к странице, а
 * контекст меняется, и мешать их в одну строку значит терять и то, и другое.
 */
export default function MagShell({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const [theme, setTheme] = useState<Theme>(readTheme);

  const nav = ({ isActive }: { isActive: boolean }) =>
    isActive ? "mag-nav-link on" : "mag-nav-link";

  function pick(next: Theme) {
    setTheme(next);
    applyTheme(next);
  }

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

        {/* Тема — свойство рабочего места, а не учётной записи: ночная смена
            за тем же профилем хочет тёмный экран, дневная — светлый. */}
        <div className="g-theme" role="group" aria-label="Тема оформления">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={theme === t.id ? "on" : ""}
              title={t.hint}
              aria-label={t.hint}
              aria-pressed={theme === t.id}
              onClick={() => pick(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <Link to="/account" className="mag-me mag-me-link">
          <span className="mag-ava">{initials(me.user.display_name)}</span>
          {me.user.display_name}
        </Link>
      </div>
      {children}
    </div>
  );
}
