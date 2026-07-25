import { useState } from "react";
import type { FormEvent } from "react";
import { ApiError, login, register, resendConfirmation } from "../../auth/api";

interface Props {
  onSignedIn: () => void;
}

type Mode = "login" | "register";

// Красная «линия маршрута» на бренд-панели: путь от датасета к модели.
function RouteLine({ stops }: { stops: string[] }) {
  const n = stops.length;
  const pos = (i: number) => 8 + (384 * i) / (n - 1);
  return (
    <div className="mag-route">
      <svg viewBox="0 0 400 46" aria-hidden="true">
        <line x1="8" y1="23" x2="392" y2="23" stroke="#e21a1a" strokeWidth="2.5" />
        {stops.map((_, i) => (
          <circle
            key={i}
            cx={pos(i)}
            cy="23"
            r="5"
            fill={i === n - 1 ? "#e21a1a" : "#23282e"}
            stroke="#e21a1a"
            strokeWidth="2.5"
          />
        ))}
      </svg>
      <div className="mag-route-cap">
        {stops.map((s) => (
          <span key={s}>{s}</span>
        ))}
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  type = "text",
  value,
  onChange,
  error,
  autoComplete,
  placeholder,
}: {
  id: string;
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  autoComplete?: string;
  placeholder?: string;
}) {
  return (
    <div className={error ? "mag-field invalid" : "mag-field"}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <div className="mag-field-error">{error}</div>}
    </div>
  );
}

export default function AuthPages({ onSignedIn }: Props) {
  const [mode, setMode] = useState<Mode>("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Set when the account exists but the emailed link hasn't been opened yet.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  // login form
  const [identity, setIdentity] = useState("");
  const [password, setPassword] = useState("");

  // register form
  const [regEmail, setRegEmail] = useState("");
  const [regLogin, setRegLogin] = useState("");
  const [regName, setRegName] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regPassword2, setRegPassword2] = useState("");

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setFieldErrors({});
  }

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(identity, password);
      onSignedIn();
    } catch (err) {
      if (err instanceof ApiError && err.code === "email_unconfirmed") {
        setPendingEmail(err.email || identity);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleResend() {
    if (!pendingEmail) return;
    setBusy(true);
    try {
      await resendConfirmation(pendingEmail);
      setResent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRegister(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    if (regPassword !== regPassword2) {
      setFieldErrors({ password2: "Пароли не совпадают." });
      return;
    }
    setBusy(true);
    try {
      const { email } = await register({
        email: regEmail,
        login: regLogin,
        display_name: regName,
        password: regPassword,
      });
      setPendingEmail(email); // сессии ещё нет: сначала подтверждение почты
    } catch (err) {
      if (err instanceof ApiError && err.fields) {
        setFieldErrors(err.fields);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mag">
      <div className="mag-auth">
        <div className="mag-brand">
          <div className="mag-mark">
            <i>М</i> Магистраль ML
          </div>
          {mode === "login" ? (
            <>
              <h2>Датасеты, разметка и обучение моделей — в одном месте</h2>
              <p>
                Платформа компьютерного зрения для задач железной дороги: от
                загрузки изображений до проверки моделей на видео.
              </p>
              <RouteLine stops={["Датасет", "Разметка", "Обучение", "Модель"]} />
            </>
          ) : (
            <>
              <h2>Создайте аккаунт и присоединяйтесь к проектам команды</h2>
              <p>
                Доступ к проектам выдаёт администратор проекта — по вашему
                логину или почте.
              </p>
              <RouteLine stops={["Аккаунт", "Проект", "Работа"]} />
            </>
          )}
        </div>

        <div className="mag-panel">
          {pendingEmail ? (
            <div>
              <h1>Подтвердите почту</h1>
              <p className="mag-sub">
                Письмо со ссылкой отправлено на <b>{pendingEmail}</b>. Откройте
                его и перейдите по ссылке — вход выполнится автоматически.
                Ссылка действует 24 часа.
              </p>
              {error && <div className="mag-error">{error}</div>}
              {resent && <div className="mag-ok">Письмо отправлено ещё раз.</div>}
              <button
                className="mag-btn"
                type="button"
                disabled={busy}
                onClick={handleResend}
              >
                {busy ? "Отправляем…" : "Отправить письмо ещё раз"}
              </button>
              <div className="mag-aux">
                <span>Не та почта?</span>
                <button
                  type="button"
                  className="mag-link"
                  onClick={() => {
                    setPendingEmail(null);
                    setResent(false);
                    setError(null);
                    switchMode("register");
                  }}
                >
                  Зарегистрироваться заново
                </button>
              </div>
            </div>
          ) : mode === "login" ? (
            <form onSubmit={handleLogin}>
              <h1>Вход в систему</h1>
              <p className="mag-sub">
                Введите логин или почту, указанные при регистрации.
              </p>
              {error && <div className="mag-error">{error}</div>}
              <Field
                id="li-identity"
                label="Логин или почта"
                value={identity}
                onChange={setIdentity}
                autoComplete="username"
              />
              <Field
                id="li-password"
                label="Пароль"
                type="password"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
              />
              <button className="mag-btn" type="submit" disabled={busy}>
                {busy ? "Входим…" : "Войти"}
              </button>
              <div className="mag-aux">
                <span>Нет аккаунта?</span>
                <button
                  type="button"
                  className="mag-link"
                  onClick={() => switchMode("register")}
                >
                  Зарегистрироваться
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleRegister}>
              <h1>Регистрация</h1>
              <p className="mag-sub">Почта используется для входа и уведомлений.</p>
              {error && <div className="mag-error">{error}</div>}
              <Field
                id="re-email"
                label="Почта"
                type="email"
                value={regEmail}
                onChange={setRegEmail}
                error={fieldErrors.email}
                autoComplete="email"
              />
              <div className="mag-cols2">
                <Field
                  id="re-login"
                  label="Логин"
                  value={regLogin}
                  onChange={setRegLogin}
                  error={fieldErrors.login}
                  autoComplete="username"
                  placeholder="isoya"
                />
                <Field
                  id="re-name"
                  label="Имя для отображения"
                  value={regName}
                  onChange={setRegName}
                  error={fieldErrors.display_name}
                  placeholder="Иван Соя"
                />
              </div>
              <div className="mag-cols2">
                <Field
                  id="re-password"
                  label="Пароль"
                  type="password"
                  value={regPassword}
                  onChange={setRegPassword}
                  error={fieldErrors.password}
                  autoComplete="new-password"
                />
                <Field
                  id="re-password2"
                  label="Повторите пароль"
                  type="password"
                  value={regPassword2}
                  onChange={setRegPassword2}
                  error={fieldErrors.password2}
                  autoComplete="new-password"
                />
              </div>
              <button className="mag-btn" type="submit" disabled={busy}>
                {busy ? "Создаём…" : "Создать аккаунт"}
              </button>
              <div className="mag-aux">
                <span>Уже есть аккаунт?</span>
                <button
                  type="button"
                  className="mag-link"
                  onClick={() => switchMode("login")}
                >
                  Войти
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
