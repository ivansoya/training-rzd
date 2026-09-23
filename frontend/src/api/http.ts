// Общая обвязка над fetch: разбор ответа и ошибка с человеческим текстом.
//
// Вынесена из auth/api.ts, когда клиентов стало пять. Сессия живёт в
// httpOnly-куке, поэтому заголовков авторизации здесь нет и быть не должно —
// браузер отправляет её сам, а перехватить её из скрипта нельзя.

// Бросается на любой неуспешный ответ. `code` — машинная причина
// («email_unconfirmed»), `fields` — сообщения по полям формы.
export class ApiError extends Error {
  code?: string;
  status: number;
  fields?: Record<string, string>;
  payload?: unknown;

  constructor(
    message: string,
    status: number,
    code?: string,
    fields?: Record<string, string>,
    payload?: unknown
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.payload = payload;
  }
}

export async function asJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data as {
      error?: string;
      code?: string;
      errors?: Record<string, string>;
    };
    const message =
      err.error ||
      (err.errors && Object.values(err.errors)[0]) ||
      `HTTP ${res.status}`;
    throw new ApiError(message, res.status, err.code, err.errors, data);
  }
  return data as T;
}

function send(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  keepalive?: boolean
): Promise<Response> {
  return fetch(`/api/${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    keepalive,
  });
}

export async function get<T>(path: string): Promise<T> {
  return asJson<T>(await fetch(`/api/${path}`));
}

// `signal` — отменить запрос, который уже никому не нужен: живое превью
// шлёт новый на каждое движение ползунка.
export async function post<T>(
  path: string,
  body: unknown = {},
  signal?: AbortSignal
): Promise<T> {
  return asJson<T>(await send("POST", path, body, signal));
}

export async function patch<T>(path: string, body: unknown = {}): Promise<T> {
  return asJson<T>(await send("PATCH", path, body));
}

// `keepalive` — запрос дойдёт, даже если вкладку уже закрывают: так уходит
// последняя правка графа.
export async function put<T>(
  path: string,
  body: unknown = {},
  keepalive = false
): Promise<T> {
  return asJson<T>(await send("PUT", path, body, undefined, keepalive));
}

export async function del<T>(path: string): Promise<T> {
  return asJson<T>(await send("DELETE", path));
}
