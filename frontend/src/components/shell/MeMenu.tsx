import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthGate";
import { Avatar, MenuItem, Popover } from "../../ui";

/** Аватар в шапке: кто вошёл, кабинет и выход. */
export default function MeMenu() {
  const { me, signOut } = useAuth();
  const navigate = useNavigate();
  return (
    <Popover align="end" width={220} trigger={
      <button type="button" className="me-btn" aria-label={`Аккаунт: ${me.user.display_name}`}>
        <Avatar name={me.user.display_name} size={28} />
      </button>
    }>
      {(close) => (
        <>
          <div className="me-h">
            <b>{me.user.display_name}</b>
            <span>{me.user.login} · {me.user.email}</span>
          </div>
          <div className="ui-pop-sep" />
          <MenuItem icon="user" onSelect={() => { close(); navigate("/account"); }}>Личный кабинет</MenuItem>
          <MenuItem icon="logout" onSelect={() => { close(); void signOut(); }}>Выйти</MenuItem>
        </>
      )}
    </Popover>
  );
}
