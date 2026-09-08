// Когда пробовать снова и когда перестать. Чистая арифметика, без сети.
//
// Вынесено отдельно, потому что ошибиться здесь легко и тихо: связь просто
// перестаёт восстанавливаться, а выглядит это как «страница застыла».

// Первая пауза, потолок паузы и сколько подряд неудач считаем поводом уйти на
// опрос совсем. Три — не магия: одна неудача бывает от моргнувшей сети, две от
// перезапуска сервиса, а три подряд означают, что мест живой связи нет.
export const FIRST_MS = 1000;
export const MAX_MS = 30_000;
export const GIVE_UP_AFTER = 3;

export function nextDelay(attempt: number): number {
  const raw = FIRST_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(raw, MAX_MS);
}

export function shouldFallBack(attempt: number): boolean {
  return attempt >= GIVE_UP_AFTER;
}

// Как часто опрашивать, когда живой связи нет. Пока что-то идёт — часто; в
// покое — редко, чтобы двадцать открытых вкладок не стучали в базу впустую.
export const POLL_BUSY_MS = 1500;
export const POLL_IDLE_MS = 15_000;

export function pollEvery(busy: boolean, hidden: boolean): number {
  // Вкладка в фоне молчит совсем: обновлять то, чего никто не видит, — это
  // расход и на клиенте, и на сервере.
  if (hidden) return 0;
  return busy ? POLL_BUSY_MS : POLL_IDLE_MS;
}
