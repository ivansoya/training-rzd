/** Приборы разжатия: след в консоли и снимок состояния по требованию.
 *
 * Разжатие кадра — единственное место редактора, где всё асинхронно и почти
 * ничего не видно снаружи: сеть, очередь, декодер браузера, кольцо разжатых
 * кадров и React-эффект, который всё это показывает. Когда картинка перестаёт
 * обновляться, по симптому не понять, кто именно встал: сеть может быть в
 * порядке, ошибок нет, а кадр не меняется.
 *
 * Поэтому след ведётся всегда в деве и никогда в бою: в собранном виде
 * `import.meta.env.DEV` ложно, вызовы остаются пустыми и сборщик их выбрасывает.
 *
 * Снимок важнее следа. Строчки говорят, что происходило, а снимок — где всё
 * застряло: `__clip()` в консоли отдаёт состояние читателя целиком.
 */

function wanted(): boolean {
  // Обращение прямое и текстом: при сборке vite подменяет именно его.
  // Через промежуточную переменную подмена не срабатывает, и в собранном
  // виде флаг оказывается пустым.
  try {
    if (import.meta.env.DEV) return true;
  } catch {
    // не vite — идём дальше
  }
  try {
    // След можно включить руками на любом стенде: иногда поймать удаётся
    // только там, где стоит nginx, а не vite.
    return localStorage.getItem("clip-debug") === "1";
  } catch {
    return false;
  }
}

const ON = wanted();

/** Последние строки следа: их удобно вывалить одним куском вместе со снимком. */
const TAIL_MAX = 400;
const tail: string[] = [];

function stamp(): string {
  return (performance.now() / 1000).toFixed(3).padStart(9, " ");
}

export function clipLog(scope: string, ...rest: unknown[]): void {
  if (!ON) return;
  const line = `${stamp()} [${scope}] ${rest
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
    .join(" ")}`;
  tail.push(line);
  if (tail.length > TAIL_MAX) tail.shift();
  // eslint-disable-next-line no-console
  console.debug(line);
}

export function clipTail(): string {
  return tail.join("\n");
}

export const clipLogOn = ON;

/** Дать консоли способ снять состояние. Зовётся читателем при рождении.
 *
 * Ставится **всегда**, а не только при включённом следе. Снимок ничего не
 * стоит, пока его не позвали, а нужен он ровно тогда, когда что-то пошло не
 * так, — и выяснять в этот момент, почему не завёлся флаг отладки, поздно.
 */
export function exposeSnapshot(take: () => unknown): void {
  if (typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>).__clip = () => {
    const snap = take();
    // eslint-disable-next-line no-console
    console.log("состояние читателя:", snap);
    // eslint-disable-next-line no-console
    console.log("след (%s строк):\n%s", tail.length, clipTail() || "(пусто)");
    if (!ON) {
      // eslint-disable-next-line no-console
      console.log(
        "след выключен. Включить: localStorage.setItem('clip-debug','1') и перезагрузить"
      );
    }
    return snap;
  };
  // Обычным log, а не debug: это должно быть видно без включённого Verbose.
  // eslint-disable-next-line no-console
  console.log(
    `[видео] снимок состояния — __clip() в консоли; след ${ON ? "включён" : "выключен"}`
  );
}

// Заглушка ставится при загрузке модуля: если читатель не открылся вовсе —
// а именно так выглядит зависшая подготовка ролика, — `__clip()` должен всё
// равно ответить, а не встретить «не определено».
if (typeof window !== "undefined") {
  const w = window as unknown as Record<string, unknown>;
  // eslint-disable-next-line no-console
  console.log(`[видео] приборы загружены, след ${ON ? "включён" : "выключен"}`);
  if (!w.__clip) {
    w.__clip = () => {
      // eslint-disable-next-line no-console
      console.log(
        "читатель ролика ещё не открыт; след:\n" + (clipTail() || "(пусто)")
      );
      return null;
    };
  }
}
