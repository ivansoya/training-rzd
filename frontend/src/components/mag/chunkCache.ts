/** Кэш сжатых перегонов: держим недавние, выбрасываем самые давние.
 *
 * Что здесь важно и почему это не просто «мапа с потолком».
 *
 * Прежде перегоны выбрасывались **по расстоянию от последнего загруженного**,
 * и это было неверно дважды. Перегон позади курсора удалялся сразу после того,
 * как дотягивался третий вперёд, — и тут же тянулся заново. А резкий переход
 * в другое место ролика стирал разом всё, что было набрано вокруг прежнего
 * места, хотя вернуться туда при разметке — обычное дело.
 *
 * По давности выходит само собой то, что нужно: всё вокруг курсора остаётся
 * свежим, потому что прогрев его каждый раз трогает, а уходит то, к чему давно
 * не возвращались. Прыгнул в другое место — прежние перегоны доживают в кэше,
 * пока он не переполнится.
 *
 * `Map` в JS хранит порядок вставки, поэтому «переложить в конец» — это и есть
 * отметка о пользовании, а самый давний всегда первый.
 */
export class ChunkCache<T> {
  private items = new Map<string, T>();

  constructor(
    readonly limit: number,
    /** Зовётся на вытесненном — чтобы хозяин знал, чего лишился. */
    private readonly onEvict?: (key: string, value: T) => void
  ) {}

  get size(): number {
    return this.items.size;
  }

  keys(): string[] {
    return [...this.items.keys()];
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  /** Взять и освежить. Само чтение — это и есть пользование. */
  get(key: string): T | undefined {
    const found = this.items.get(key);
    if (found === undefined) return undefined;
    this.items.delete(key);
    this.items.set(key, found);
    return found;
  }

  /** Посмотреть, не освежая: нужно там, где мы только проверяем наличие. */
  peek(key: string): T | undefined {
    return this.items.get(key);
  }

  set(key: string, value: T): void {
    this.items.delete(key);
    this.items.set(key, value);
    while (this.items.size > this.limit) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      const gone = this.items.get(oldest)!;
      this.items.delete(oldest);
      this.onEvict?.(oldest, gone);
    }
  }

  delete(key: string): void {
    this.items.delete(key);
  }

  clear(): void {
    this.items.clear();
  }
}
