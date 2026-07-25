import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { confirmEmail } from "../../auth/api";

// Landing for the link from the confirmation email. On success the backend
// starts a session, so a full reload drops the user straight into the app.
export default function ConfirmPage() {
  const { token } = useParams<{ token: string }>();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) return;
    confirmEmail(token)
      .then(() => {
        setDone(true);
        window.location.replace("/");
      })
      .catch((e) => setError((e as Error).message));
  }, [token]);

  return (
    <div className="mag">
      <div className="mag-splash">
        {error ? (
          <div className="mag-confirm-box">
            <h1>Не получилось подтвердить почту</h1>
            <p>{error}</p>
            <a className="mag-link" href="/">
              На страницу входа
            </a>
          </div>
        ) : done ? (
          "Почта подтверждена — входим…"
        ) : (
          "Подтверждаем почту…"
        )}
      </div>
    </div>
  );
}
