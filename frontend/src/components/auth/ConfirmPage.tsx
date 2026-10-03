import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { confirmEmail } from "../../auth/api";

// Страница ссылки из письма. Входа здесь нет: ссылку мог прислать кто угодно,
// и открывший её не должен молча оказаться в чужом аккаунте.
export default function ConfirmPage() {
  const { token } = useParams<{ token: string }>();
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    confirmEmail(token)
      .then((r) => setLogin(r.login))
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
        ) : login ? (
          <div className="mag-confirm-box">
            <h1>Почта подтверждена</h1>
            <p>Войдите под логином <b>{login}</b>.</p>
            <a className="mag-link" href="/">
              На страницу входа
            </a>
          </div>
        ) : (
          "Подтверждаем почту…"
        )}
      </div>
    </div>
  );
}
