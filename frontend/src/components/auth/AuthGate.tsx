import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { errorText, fetchMe, logout, UNAUTHORIZED_EVENT } from "../../auth/api";
import type { Me } from "../../auth/api";
import AuthPages from "./AuthPages";

interface AuthState {
  me: Me;
  refresh: () => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthGate>");
  return ctx;
}

// Gate in front of the app: shows login/registration until the session cookie
// is valid. Keeps last_seen fresh by re-checking the session once a minute.
export default function AuthGate({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  // Сбой проверки сессии (502, сеть) — это не «вы не вошли». Раньше любой
  // сбой показывал форму входа человеку с живой сессией.
  const [down, setDown] = useState<string | null>(null);
  const meRef = useRef<Me | null>(null);
  meRef.current = me;

  const refresh = useCallback(async () => {
    try {
      setMe(await fetchMe());
      setDown(null);
    } catch (e) {
      // Уже вошедшего не выкидываем из-за одного сбоя: остаётся прежний me.
      if (!meRef.current) setDown(errorText(e));
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Любой 401 из auth/api.ts — сессия отозвана: обратно на вход.
  useEffect(() => {
    const lost = () => setMe(null);
    window.addEventListener(UNAUTHORIZED_EVENT, lost);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, lost);
  }, []);

  // Пульс держит «в сети» и заодно замечает отозванную сессию. На возврат во
  // вкладку — сразу, а не через минуту: пароль чаще всего меняют в соседней.
  useEffect(() => {
    if (!me) return;
    const ping = () => {
      fetch("/api/auth/me")
        .then((r) => {
          if (r.status === 401) setMe(null);
        })
        .catch(() => {});
    };
    const h = setInterval(ping, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") ping();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(h);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [me]);

  const signOut = useCallback(() => {
    logout()
      .catch(() => {})
      .finally(() => setMe(null));
  }, []);

  if (!checked) {
    return (
      <div className="mag">
        <div className="mag-splash">Проверяем сессию…</div>
      </div>
    );
  }

  if (!me && down) {
    return (
      <div className="mag">
        <div className="mag-splash">
          <div className="mag-error">Сервер недоступен: {down}</div>
          <button className="mag-btn mag-btn-inline" type="button" onClick={refresh}>
            Повторить
          </button>
        </div>
      </div>
    );
  }

  if (!me) {
    return <AuthPages onSignedIn={refresh} />;
  }

  return (
    <AuthContext.Provider value={{ me, refresh, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
