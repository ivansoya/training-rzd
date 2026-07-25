import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { ReactNode } from "react";
import { fetchMe, logout } from "../../auth/api";
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

  const refresh = useCallback(async () => {
    try {
      setMe(await fetchMe());
    } catch {
      setMe(null);
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Heartbeat: authenticated ping so "online" status on project pages works.
  useEffect(() => {
    if (!me) return;
    const h = setInterval(() => {
      fetch("/api/auth/me").catch(() => {});
    }, 60_000);
    return () => clearInterval(h);
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

  if (!me) {
    return <AuthPages onSignedIn={refresh} />;
  }

  return (
    <AuthContext.Provider value={{ me, refresh, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
