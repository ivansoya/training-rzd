import { DataStream, MP4BoxBuffer, createFile } from "mp4box";
import type { Sample } from "mp4box";
import { chunkUrl } from "../../auth/api";
import { ChunkCache } from "./chunkCache";
import { clipLog, exposeSnapshot } from "./clipLog";
import { feedPlan } from "./feedPlan";
import { Stalled, serialQueue, withDeadline } from "./decodeQueue";
import type { ClipChunk, ClipManifest, ClipProgress } from "../../auth/api";

/** Разжатие ролика в браузере: перегоны приезжают видео, кадры достаёт клиент.
 *
 * Раньше кадр приезжал картинкой с сервера — на 2688×1520 один прогрев окна
 * стоил больше сотни мегабайт. Теперь приезжает перегон: 120 кадров видео,
 * которые разжимает `VideoDecoder`.
 *
 * Три правила, на которых всё держится.
 *
 * **Номер кадра не вычисляется.** Перечень перегонов объявлен сервером, и
 * заголовки самого перегона повторяют, какие кадры внутри. Клиент ищет в этом
 * перечне, но никогда не делит на 120 и не считает номер из времени.
 *
 * **Порядок показа и порядок разжатия — разные.** Кодировщик переставляет
 * кадры (B-кадры ссылаются вперёд), поэтому декодер отдаёт их не в том
 * порядке, в каком получил. Номер кадра берётся из времени показа, а не из
 * счётчика выданных кадров — иначе бокс уехал бы на соседний кадр.
 *
 * **В кольце лежат копии, а не кадры декодера.** `VideoFrame` — это буфер
 * декодера, и пока он открыт, декодер им занят. Запас буферов невелик:
 * подержав девять кадров, декодер замолкает совсем — без ошибки и без
 * события. Поэтому копия снимается сразу на выходе, а кадр отпускается.
 */

// Кадров вокруг курсора держим разжатыми. Шаг стрелкой в обе стороны —
// мгновенный; прыжок дальше требует разжать перегон заново.
//
// Держим копии (`ImageBitmap`), а не сами разжатые кадры, и это не мелочь.
// `VideoFrame` — это буфер декодера, и пока он открыт, декодер им занят. У
// запаса буферов есть дно: на первом же реальном ролике декодер выдавал ровно
// девять кадров и замолкал — без ошибки, без события, с десятью кадрами в
// очереди и состоянием «configured». Пересоздание декодера не помогало,
// потому что кадры оставались открытыми. Снаружи это выглядело как
// бесконечная загрузка после десятка показанных кадров.
//
// Копия стоит одного снимка на кадр и не держит ничего чужого. Взамен она
// стоит памяти, поэтому окно заметно уже прежнего.
const RING_BEHIND = 4;
const RING_AHEAD = 10;
// Насколько вперёд тянем перегоны байтами. Три — это около пятнадцати секунд
// хода вперёд на 25 к/с, и стоит это около мегабайта на перегон. Запас нужен
// не памяти, а серверу: перегон, которого ещё нет, он режет на месте, и
// спросив пораньше, мы прячем эту работу.
const AHEAD_CHUNKS = 3;
const BEHIND_CHUNKS = 1;
// Сколько сжатых перегонов держим в памяти. Больше, чем нужно прямо сейчас
// (текущий, три вперёд, один назад): после прыжка в другое место прежние не
// выбрасываются сразу, а доживают в кэше — вернуться назад тогда ничего не
// стоит. Восемь перегонов — это около семи мегабайт на пожатой ступени и
// около двадцати на исходной.
const CHUNK_CACHE = 8;

/** Ступень качества — её идентификатор из манифеста: «src» или высота. */
export type Quality = string;

// Сколько ждём перегон, который сервер ещё готовит. Нарезка уехала в
// отдельный процесс, и «ещё не готов» — это теперь обычный ответ, а не сбой.
// Три минуты — потолок на случай, если воркер лёг совсем: дальше человеку
// честнее сказать, что не дождались, чем крутить точку вечно.
const PREPARE_DEADLINE_MS = 180_000;
// Отказ помнится: без этого одно движение по таймлайну по битому ролику
// превращалось в поток запросов, а каждый заводил на сервере новую работу.
const FAILURE_COOLDOWN_MS = 30_000;

/** Кадр перегона: байты для декодера и его номер в ролике.
 *
 * Номер проставляется здесь и уезжает в декодер меткой времени. Декодер
 * возвращает метку нетронутой, поэтому выданный кадр сам говорит, кто он, —
 * и говорить это он может, даже если декодер тем временем ушёл в следующий
 * перегон. Без этого поток через границу не пустить: у каждого перегона своё
 * время, начинающееся с нуля, и метки соседей совпали бы.
 */
interface ChunkFrame {
  data: Uint8Array;
  key: boolean;
  /** Место в порядке показа внутри перегона. */
  pres: number;
  /** Номер кадра в ролике целиком. */
  no: number;
}

interface Loaded {
  chunk: ClipChunk;
  /** Ступень, в которой перегон реально приехал: с ней настроен декодер. */
  quality: Quality;
  codec: string;
  description: Uint8Array;
  /** Кадры в порядке разжатия — том, в каком их надо скармливать декодеру. */
  samples: ChunkFrame[];
}

export class ClipError extends Error {}

/** Отказ, который не надо повторять сразу: сервер сказал, что не смог. */
export class ClipFailure extends ClipError {}

/** Разжатие застряло. Повторяемо: обычно хватает завести декодер заново.
 *
 * Отдельный тип нужен затем, чтобы такое не показывали человеку как поломку:
 * это не «кадр испорчен», а «браузер задумался», и правильный ответ —
 * попробовать ещё раз, а не гасить редактор.
 */
export { Stalled as ClipStalled } from "./decodeQueue";

// Ни одно ожидание внутри разжатия не имеет права длиться вечно.
//
// Декодер — чужой код в браузере, и он может замолчать: после ошибки
// `flush()` иногда не завершается вовсе. Очередь разжатия одна на редактор,
// поэтому одно незавершённое обещание останавливает не кадр, а весь редактор
// — при живой сети, целых перегонах и без единой ошибки в консоли. Ровно так
// это и выглядело снаружи: бесконечная загрузка после случайной перемотки.
const FLUSH_DEADLINE = 3_000;
const DECODE_DEADLINE = 10_000;

/** Перегона ещё нет на руках — он едет или готовится на сервере.
 *
 * Не ошибка, а «приходите через `retryAfterMs`». Отдельный тип нужен потому,
 * что ожидание вынесено из очереди разжатия: ждать внутри неё значило бы
 * запереть редактор целиком — даже там, где кадры давно лежат в кольце.
 */
export class ClipPending extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Перегон ещё готовится.");
  }
}

// Как часто редактор заглядывает, не приехал ли перегон. Это проверка в
// памяти, а не запрос: по сети за ним ходит фоновая доставка, и она сама
// выдерживает паузу, которую назвал сервер.
const RECHECK_MS = 400;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new ClipError("Ожидание прервано."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Описание кодека для `VideoDecoder`: avcC без заголовка бокса. */
function description(sample: Sample): Uint8Array {
  const entry = sample.description as unknown as Record<string, unknown>;
  const box = (entry.avcC || entry.hvcC || entry.vpcC || entry.av1C) as
    | { write: (s: unknown) => void }
    | undefined;
  if (!box) throw new ClipError("В перегоне нет описания кодека.");
  // Порядок байт по умолчанию у mp4box — старшим вперёд, как и в самом mp4.
  const stream = new DataStream(undefined, 0);
  box.write(stream);
  // Первые восемь байт — заголовок бокса; декодеру нужно только содержимое.
  return new Uint8Array(stream.buffer, 8);
}

/** Разобрать mp4 перегона на кадры. Синхронно: mp4box отдаёт всё на flush. */
function demux(bytes: ArrayBuffer): Omit<Loaded, "chunk" | "quality"> {
  const file = createFile();
  let codec = "";
  let desc: Uint8Array | null = null;
  const samples: ChunkFrame[] = [];
  let failure: string | null = null;

  file.onError = (err: unknown) => {
    failure = String(err);
  };
  file.onReady = (info) => {
    const track = info.videoTracks[0];
    if (!track) {
      failure = "В перегоне нет видеодорожки.";
      return;
    }
    codec = track.codec;
    file.setExtractionOptions(track.id, null, { nbSamples: 1_000_000 });
    file.start();
  };
  file.onSamples = (_id, _user, list) => {
    for (const s of list) {
      if (!desc) desc = description(s);
      if (!s.data) continue;
      samples.push({
        data: new Uint8Array(s.data),
        key: s.is_sync,
        pres: s.cts,   // пока время показа; ниже станет порядковым номером
        no: -1,
      });
    }
  };

  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(bytes, 0), true);
  file.flush();

  if (failure) throw new ClipError(failure);
  if (!desc || !samples.length) throw new ClipError("Перегон разобрать не удалось.");

  // Номер кадра — место в порядке показа, а не в порядке разжатия. Кодировщик
  // переставляет кадры, и счётчик выданных здесь соврал бы.
  [...samples]
    .sort((a, b) => a.pres - b.pres)
    .forEach((s, i) => {
      s.pres = i;
    });

  return { codec, description: desc, samples };
}

/** Открытый декодер: пока идём по перегону вперёд, он продолжает работать. */
/** Открытый декодер: он идёт по ролику, а не по одному перегону.
 *
 * Перегон начинается с опорного кадра, а описание потока у соседних перегонов
 * одной ступени одно и то же, — значит следующий перегон можно скармливать
 * тому же декодеру, не перенастраивая его и ничего не сливая. Именно это и
 * делает переход через границу незаметным: раньше там заводился второй
 * декодер, и на стыке ролик заметно перезагружался.
 */
interface Active {
  /** По какому перегону кормим сейчас. Меняется на ходу. */
  chunkNo: number;
  quality: Quality;
  /** Описание потока, по которому декодер настроен. Перегон с другим
   *  описанием тем же декодером не пустить. */
  description: Uint8Array;
  decoder: VideoDecoder;
  /** Сколько кадров текущего перегона уже скормлено. */
  fed: number;
  /** Наибольший **номер в ролике**, который декодер уже выдал. По нему видно,
   *  идёт ли нужный кадр к нам прямо сейчас или его уже не будет. */
  emitted: number;
  /** После слива декодер снова требует опорный кадр — обычный он не примет. */
  needsKey: boolean;
  /** Ошибка декодера приходит своим ходом; её забирает тот, кто ждёт кадр. */
  failure: Error | null;
}

/** Одинаковы ли описания потока: только тогда перегоны — один поток. */
function sameStream(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export function webCodecsMissing(): boolean {
  return typeof window === "undefined" || typeof window.VideoDecoder === "undefined";
}

export class ClipReader {
  readonly manifest: ClipManifest;
  private taskId: string;
  private videoId: string;
  private quality: Quality;

  private loaded = new ChunkCache<Loaded>(CHUNK_CACHE, (key) =>
    clipLog("кэш", `вытеснен перегон ${key}`)
  );
  private loading = new Map<string, Promise<Loaded>>();
  private ring = new Map<number, ImageBitmap>();
  private active: Active | null = null;
  /** Растёт при смене качества. Всё, что начато раньше, в состояние не пишет:
   *  иначе загрузка прежнего качества дописывается в кэш уже после переключения,
   *  и кадр приезжает не тот, что просили. */
  private gen = 0;
  /** Последний запрошенный кадр: по нему видно, что просьба устарела. */
  private latest = -1;
  /** Разжатие идёт по очереди: два декодера на один перегон только мешают.
   *  Сама очередь — в `decodeQueue`, там же её и проверяют числами. */
  private enqueue = serialQueue();
  private closed = false;
  /** Отменяет всё, что едет по сети, когда редактор закрывают. Без этого
   *  сервер продолжал готовить ступень для ушедшего человека. */
  private stop = new AbortController();
  /** Перегоны, на которые сервер ответил отказом, и когда это было. */
  private failures = new Map<string, { message: string; at: number }>();
  /** Что сервер сейчас готовит — чтобы редактор показал полосу, а не точку. */
  onProgress: ((progress: ClipProgress | null) => void) | null = null;

  constructor(taskId: string, videoId: string, manifest: ClipManifest) {
    this.taskId = taskId;
    this.videoId = videoId;
    this.manifest = manifest;
    this.quality = manifest.quality || manifest.default_quality;
    clipLog("читатель", "открыт", {
      кадров: manifest.frame_count,
      перегонов: manifest.chunks.length,
      ступень: this.quality,
    });
    exposeSnapshot(() => this.snapshot());
  }

  /** Всё состояние разжатия одним куском — для консоли. */
  snapshot() {
    const ring = [...this.ring.keys()].sort((a, b) => a - b);
    const say = (a: Active | null) =>
      a && {
        перегон: a.chunkNo,
        ступень: a.quality,
        скормлено: a.fed,
        состояние: a.decoder.state,
        очередьДекодера: a.decoder.decodeQueueSize,
        нуженОпорный: a.needsKey,
        ошибка: a.failure ? String(a.failure) : null,
      };
    return {
      ступень: this.quality,
      поколение: this.gen,
      последнийЗапрос: this.latest,
      закрыт: this.closed,
      кольцо: ring.length ? { сколько: ring.length, от: ring[0], до: ring[ring.length - 1] } : null,
      окно: this.keep,
      перегоныВПамяти: this.loaded.keys(),
      едут: [...this.loading.keys()],
      отказы: [...this.failures.entries()].map(([k, v]) => [k, v.message]),
      текущий: say(this.active),
      ждёт: this.waiting ? this.waiting.frameNo : null,
    };
  }

  /** Перегон, в котором лежит кадр. Поиск по объявленному перечню. */
  chunkFor(frameNo: number): ClipChunk | null {
    const chunks = this.manifest.chunks;
    let lo = 0;
    let hi = chunks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = chunks[mid];
      if (frameNo < c.first) hi = mid - 1;
      else if (frameNo >= c.first + c.count) lo = mid + 1;
      else return c;
    }
    return null;
  }

  setQuality(quality: Quality) {
    if (quality === this.quality) return;
    clipLog("ступень", `${this.quality || "(пусто)"} → ${quality}: всё сбрасываем`);
    this.quality = quality;
    this.gen += 1;
    // Картинка другая — и сжатые перегоны, и разжатые кадры больше не годятся.
    this.dropActive();
    this.loaded.clear();
    this.loading.clear();
    this.ring.forEach((f) => f.close());
    this.ring.clear();
  }

  currentQuality(): Quality {
    return this.quality;
  }

  /** Кадр из кольца, если он там уже есть. Синхронно и без обещаний. */
  peek(frameNo: number): ImageBitmap | null {
    return this.ring.get(frameNo) ?? null;
  }

  /** Кадр по номеру. Разжимает столько, сколько нужно, и не больше. */
  frame(frameNo: number): Promise<ImageBitmap | null> {
    const have = this.ring.get(frameNo);
    if (have) return Promise.resolve(have);
    this.latest = frameNo;
    return this.enqueue(async () => {
      const ready = this.ring.get(frameNo);
      if (ready) return ready;
      // Пока просьба стояла в очереди, курсор уехал дальше — при проигрывании
      // это обычное дело. Разжимать кадр, который уже никому не нужен, значит
      // копить отставание: очередь растёт, а картинка не догоняет.
      if (this.latest !== frameNo) return null;
      // Потолок на всё разжатие. Он же — единственное, что не даёт очереди
      // встать навсегда: задача, которая не завершилась, держит не себя, а
      // всех, кто выстроился за ней.
      try {
        await withDeadline(
          this.fill(frameNo), DECODE_DEADLINE, `Кадр ${frameNo}`
        );
      } catch (err) {
        clipLog("кадр", `${frameNo}: не вышло —`, String(err));
        if (err instanceof Stalled) {
          // Брошенное разжатие продолжит работать само по себе. Отцепляем от
          // него декодер, чтобы следующая попытка начала с чистого листа.
          this.dropActive();
        }
        throw err;
      }
      const got = this.ring.get(frameNo) ?? null;
      if (!got) {
        clipLog("кадр", `${frameNo}: разжали, но в кольце его нет`, {
          окно: this.keep,
          кольцо: [...this.ring.keys()].sort((a, b) => a - b),
        });
      }
      return got;
    });
  }

  /** Притащить соседние перегоны, пока их не спросили.
   *
   * Что тянуть — решает текущее место: три перегона вперёд и один назад.
   * Заодно это освежает их в кэше, поэтому при обычном ходе по ролику
   * вытесняется всегда самое дальнее от курсора.
   */
  warm(frameNo: number) {
    const here = this.chunkFor(frameNo);
    if (!here) return;
    const wanted: number[] = [];
    for (let i = BEHIND_CHUNKS; i >= 1; i -= 1) wanted.push(here.n - i);
    wanted.push(here.n);
    for (let i = 1; i <= AHEAD_CHUNKS; i += 1) wanted.push(here.n + i);
    for (const n of wanted) {
      const chunk = this.manifest.chunks[n];
      if (!chunk) continue;
      const key = this.key(n);
      // Всё, что рядом с курсором, — свежее: пусть вытесняется не оно.
      if (this.loaded.get(key)) continue;
      if (this.loading.has(key)) continue;
      clipLog("прогрев", `заказан перегон ${n}`);
      // Прогрев — ускорение, а не условие работы: перегон всё равно
      // приедет обычным путём. Отказ здесь глушится намеренно, иначе
      // каждая неудачная попытка всплывала бы необработанным обещанием.
      this.load(chunk).catch(() => undefined);
    }
  }

  dispose() {
    this.closed = true;
    // Всё, что едет по сети, — отменить. Человек ушёл со страницы, и держать
    // сервер за подготовку ступени, которую никто не увидит, незачем.
    this.stop.abort();
    this.onProgress = null;
    this.dropActive();
    this.ring.forEach((f) => f.close());
    this.ring.clear();
    this.loaded.clear();
    this.loading.clear();
  }

  // ----------------------------------------------------------------- частное

  private key(chunkNo: number, quality = this.quality) {
    return `${quality}:${chunkNo}`;
  }

  private async load(chunk: ClipChunk): Promise<Loaded> {
    const key = this.key(chunk.n);
    const gen = this.gen;
    const cached = this.loaded.get(key);
    if (cached) return cached;
    const running = this.loading.get(key);
    if (running) return running;

    const quality = this.quality;
    const task = (async () => {
      const bytes = await this.pull(chunk, quality);
      const parts = demux(bytes);
      if (parts.samples.length !== chunk.count) {
        throw new ClipError(
          `В перегоне ${chunk.n} разобралось ${parts.samples.length} кадров ` +
            `вместо ${chunk.count}.`
        );
      }
      // Номер в ролике проставляем здесь: демуксер про перегон не знает.
      for (const s of parts.samples) s.no = chunk.first + s.pres;
      const loaded: Loaded = { chunk, quality, ...parts };
      // Качество успели переключить, пока перегон ехал: эти байты уже не те,
      // что просят, и в кэш им нельзя — иначе они лягут под новым ключом.
      if (!this.closed && gen === this.gen) {
        this.loaded.set(key, loaded);
      }
      return loaded;
    })();

    this.loading.set(key, task);
    try {
      return await task;
    } finally {
      this.loading.delete(key);
    }
  }

  /** Забрать байты перегона у сервера, дождавшись, если он их ещё готовит.
   *
   * Ответов три, и они означают разное. «200» — вот перегон. «202» — сервер
   * взял работу в очередь и ещё не дошёл; это обычный ход дела, а не сбой, и
   * правильный ответ на него — подождать и спросить снова. «409» — сервер
   * попробовал и не смог; повторять сразу бессмысленно, поэтому отказ
   * запоминается и какое-то время выдаётся сразу, без похода по сети.
   */
  private async pull(chunk: ClipChunk, quality: Quality): Promise<ArrayBuffer> {
    const key = this.key(chunk.n, quality);
    const failed = this.failures.get(key);
    if (failed && Date.now() - failed.at < FAILURE_COOLDOWN_MS) {
      throw new ClipFailure(failed.message);
    }
    this.failures.delete(key);

    const until = Date.now() + PREPARE_DEADLINE_MS;
    for (;;) {
      const res = await fetch(
        chunkUrl(this.taskId, this.videoId, chunk.n, quality),
        { credentials: "same-origin", signal: this.stop.signal }
      );

      clipLog("сеть", `перегон ${chunk.n} (${quality}): ${res.status}`);
      if (res.status === 202) {
        const body = await res.json().catch(() => ({}));
        this.onProgress?.(
          body.processed !== undefined
            ? {
                kind: body.stage ?? "chunk",
                quality: body.quality ?? quality,
                status: "running",
                processed: body.processed ?? 0,
                total: body.total ?? 0,
              }
            : null
        );
        if (Date.now() >= until) {
          throw new ClipError(
            `Перегон ${chunk.n} готовится слишком долго. Попробуйте позже.`
          );
        }
        await sleep(Number(body.retry_after_ms) || 700, this.stop.signal);
        continue;
      }

      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        const message = body.error || `Перегон ${chunk.n} подготовить не удалось.`;
        this.failures.set(key, { message, at: Date.now() });
        this.onProgress?.(null);
        throw new ClipFailure(message);
      }

      if (!res.ok) {
        throw new ClipError(`Перегон ${chunk.n} не приехал (${res.status}).`);
      }

      // Сервер повторяет в заголовках, какие кадры внутри и в какой ступени.
      // Расхождение с манифестом означает, что ролик подменили, и разметка
      // указывает не туда.
      const first = Number(res.headers.get("X-Chunk-First"));
      const count = Number(res.headers.get("X-Chunk-Count"));
      if (first !== chunk.first || count !== chunk.count) {
        throw new ClipError(
          `Перегон ${chunk.n} обещает кадры с ${first} (${count} шт.), ` +
            `а в списке ролика — с ${chunk.first} (${chunk.count} шт.).`
        );
      }
      const got = res.headers.get("X-Chunk-Quality");
      if (got && got !== quality) {
        throw new ClipError(
          `Перегон ${chunk.n} приехал в ступени ${got}, а просили ${quality}.`
        );
      }
      this.onProgress?.(null);
      return await res.arrayBuffer();
    }
  }

  private dropActive() {
    if (!this.active) return;
    this.shut(this.active.decoder);
    this.active = null;
    // Разбудить того, кто ждал кадр от этого декодера: иначе он повиснет до
    // истечения ожидания, а на экране всё это время будет прежний кадр.
    this.waiting?.resolve();
  }

  private shut(decoder: VideoDecoder) {
    try {
      if (decoder.state !== "closed") decoder.close();
    } catch {
      // Декодер мог закрыться сам после ошибки — это не повод падать.
    }
  }

  /** Нужен ли нам этот кадр: кольцо вокруг курсора. Всё остальное
   *  закрывается сразу — открытая копия стоит памяти, открытый кадр
   *  декодера стоил бы самого декодера. */
  private wanted(no: number): boolean {
    return no >= this.keep.from && no <= this.keep.to;
  }

  /** Ближайший опорный кадр на этом месте или левее.
   *
   *  Кормить декодер можно только с опорного кадра. Их в перегоне несколько:
   *  кодировщик ставит свои на смене плана, — поэтому возврат назад обходится
   *  десятком кадров, а не разжатием перегона с начала. */
  private keyBefore(loaded: Loaded, local: number): number {
    for (let i = Math.min(local, loaded.samples.length - 1); i > 0; i -= 1) {
      if (loaded.samples[i].key) return i;
    }
    return 0;
  }

  /** Заказать перегон в фоне, если его ещё никто не везёт. */
  private want(chunk: ClipChunk) {
    const key = this.key(chunk.n);
    if (this.loaded.has(key) || this.loading.has(key)) return;
    this.load(chunk).catch(() => undefined);
  }

  /** Разжать всё, что нужно, чтобы кадр оказался в кольце.
   *
   * По сети отсюда не ходят. Очередь разжатия одна на редактор, и ожидание
   * внутри неё запирало бы всё: пока едет перегон с сотого кадра, не
   * показать и десятый, который уже разжат. Нет байтов — заказываем доставку
   * и говорим «приходите позже».
   */
  private async fill(frameNo: number) {
    const chunk = this.chunkFor(frameNo);
    if (!chunk) throw new ClipError(`Кадра ${frameNo} нет в ролике.`);
    const loaded = this.loaded.get(this.key(chunk.n));
    if (!loaded) {
      const failed = this.failures.get(this.key(chunk.n));
      if (failed && Date.now() - failed.at < FAILURE_COOLDOWN_MS) {
        throw new ClipFailure(failed.message);
      }
      clipLog("разжатие", `кадр ${frameNo}: перегона ${chunk.n} нет в памяти`, {
        едут: [...this.loading.keys()],
        есть: this.loaded.keys(),
      });
      this.want(chunk);
      throw new ClipPending(RECHECK_MS);
    }
    if (this.closed) return;

    const local = frameNo - chunk.first;
    this.keep = { from: frameNo - RING_BEHIND, to: frameNo + RING_AHEAD };

    const current = this.seat(loaded, chunk, local, frameNo);
    this.feed(current, frameNo);

    // Ждём именно нужный кадр. Сливать декодер после каждой порции нельзя:
    // после слива он требует опорный кадр, и продолжить проигрывание с
    // обычного уже не выйдет — ровно на этом ломалось проигрывание.
    await this.awaitFrame(frameNo, current);
    this.trimRing(frameNo);
  }

  /** Посадить декодер на нужное место потока.
   *
   * Тот же декодер годится для любого перегона той же ступени: перегон
   * начинается с опорного кадра, а описание потока у соседей одно и то же.
   * Поэтому «перейти в другой перегон» и «отмотать назад» — это не новый
   * декодер, а другая точка, с которой его кормят. Новый заводится только
   * когда поток и правда другой: сменилась ступень или декодер умер.
   */
  private seat(
    loaded: Loaded,
    chunk: ClipChunk,
    local: number,
    frameNo: number
  ): Active {
    const a = this.active;
    const same =
      a !== null &&
      a.quality === loaded.quality &&
      a.decoder.state === "configured" &&
      !a.failure &&
      sameStream(a.description, loaded.description);

    if (same) {
      // Идём вперёд по тому же перегону — просто продолжаем кормить. Либо
      // нужный кадр ещё в пути: декодер отдаёт в порядке показа, и всё, что
      // дальше показанного, к нам ещё придёт.
      const goes =
        a.chunkNo === chunk.n &&
        !a.needsKey &&
        (a.fed <= local || frameNo > a.emitted);
      if (goes) return a;

      const from = this.keyBefore(loaded, local);
      clipLog("разжатие", `кадр ${frameNo}: тот же декодер, с ${chunk.n}:${from}`, {
        было: { перегон: a.chunkNo, скормлено: a.fed, показано: a.emitted },
      });
      a.chunkNo = chunk.n;
      a.fed = from;
      a.needsKey = false;
      a.emitted = chunk.first + from - 1;
      return a;
    }

    clipLog("разжатие", `кадр ${frameNo}: декодер заново`, {
      перегон: chunk.n,
      было: a
        ? {
            перегон: a.chunkNo,
            состояние: a.decoder.state,
            ошибка: a.failure ? String(a.failure) : null,
          }
        : null,
    });
    this.dropActive();
    const made: Active = {
      chunkNo: chunk.n,
      quality: loaded.quality,
      description: loaded.description,
      decoder: this.makeDecoder(),
      fed: this.keyBefore(loaded, local),
      emitted: -1,
      needsKey: false,
      failure: null,
    };
    this.active = made;
    made.decoder.configure({
      codec: loaded.codec,
      description: loaded.description,
      optimizeForLatency: true,
    });
    return made;
  }

  /** Скормить декодеру всё до запаса вперёд, **переходя через границы**.
   *
   * Здесь и лечится стык. Раньше кормление упиралось в конец своего перегона,
   * и на границе всё начиналось заново — ролик заметно перезагружался ровно в
   * тот момент, когда идёт. Теперь следующий перегон досыпается в тот же
   * декодер: для него это продолжение потока, а не новый файл.
   *
   * Сама арифметика — в `feedPlan`, и проверяется она числами: пропущенный на
   * стыке кадр это не дёрнувшаяся картинка, а бокс на соседнем кадре.
   */
  private feed(active: Active, frameNo: number) {
    const plan = feedPlan(
      this.manifest.chunks,
      active.chunkNo,
      active.fed,
      frameNo + RING_AHEAD,
      (n) => {
        const bytes = this.loaded.peek(this.key(n));
        return Boolean(bytes) && sameStream(bytes!.description, active.description);
      }
    );

    for (const span of plan.spans) {
      const bytes = this.loaded.peek(this.key(span.chunk));
      if (!bytes) continue;
      if (span.chunk !== active.chunkNo) {
        clipLog("разжатие", `перегон ${span.chunk} досыпан в тот же декодер`);
      }
      for (let i = span.from; i <= span.to; i += 1) {
        const s = bytes.samples[i];
        active.decoder.decode(
          new EncodedVideoChunk({
            type: s.key ? "key" : "delta",
            // Метка времени — номер кадра в ролике. Декодер вернёт её как
            // есть, и выданный кадр сам скажет, кто он, даже если декодер к
            // тому времени ушёл в следующий перегон.
            timestamp: s.no,
            data: s.data,
          })
        );
      }
      active.chunkNo = span.chunk;
    }
    active.chunkNo = plan.chunk;
    active.fed = plan.fed;

    if (plan.wantNext !== null) {
      const after = this.manifest.chunks[plan.wantNext];
      if (after) this.want(after);
    }
  }

  /** Дождаться, пока кадр выйдет из декодера.
   *
   * Кормить здесь уже нечем: `feed` отдал всё, до чего дотянулся, включая
   * следующий перегон. Остаётся ждать — и, если не дождались, сливать.
   */
  private async awaitFrame(frameNo: number, active: Active) {
    if (this.ring.has(frameNo)) return;
    if (active.failure) throw active.failure;

    let woke = "callback";
    await new Promise<void>((resolve) => {
      let timer = 0;
      const done = () => {
        if (this.waiting?.resolve === done) this.waiting = null;
        if (timer) window.clearTimeout(timer);
        resolve();
      };
      const late = () => {
        woke = "таймаут";
        done();
      };
      // Ждать вечно нельзя: декодер может и промолчать, а разметчик смотрит на
      // застывший кадр. Не дождались — идём сливать.
      timer = window.setTimeout(late, 2000);
      this.waiting = { frameNo, resolve: done };
      // Кадр мог прийти, пока мы сюда добирались.
      if (this.ring.has(frameNo) || active.failure) done();
    });

    if (this.ring.has(frameNo)) return;
    if (active.failure) throw active.failure;
    clipLog("ожидание", `кадр ${frameNo}: не вышел (${woke}), идём на слив`, {
      перегон: active.chunkNo,
      скормлено: active.fed,
      показано: active.emitted,
      очередьДекодера: active.decoder.decodeQueueSize,
      состояние: active.decoder.state,
    });

    // Кадр не вышел, хотя всё нужное скормлено, — значит он застрял в
    // конвейере, и достать его можно только сливом. После него декодеру
    // снова нужен опорный кадр, о чём и помечаем.
    if (active.decoder.state === "configured") {
      try {
        await withDeadline(active.decoder.flush(), FLUSH_DEADLINE, "Слив декодера");
      } catch (err) {
        // Слив после ошибки декодера может не завершиться вовсе. Держать
        // очередь ради него нельзя: заводим декодер заново на следующем
        // заходе.
        active.needsKey = true;
        this.dropActive();
        throw err instanceof Error ? err : new Stalled("Декодер не отозвался.");
      }
      active.needsKey = true;
    }
    if (active.failure) throw active.failure;
    if (!this.ring.has(frameNo)) {
      throw new ClipError(`Кадр ${frameNo} не разжался.`);
    }
  }

  /** Кто ждёт кадр: разбудит его callback декодера, когда тот выйдет. */
  private waiting: { frameNo: number; resolve: () => void } | null = null;


  /** Границы кольца на текущее разжатие: что вне — закрываем сразу. */
  private keep = { from: 0, to: 0 };

  private makeDecoder(): VideoDecoder {
    const decoder: VideoDecoder = new VideoDecoder({
      output: (frame) => {
        // Номер кадра — это метка времени, которую мы сами и поставили при
        // кормлении. Считать выданные кадры нельзя: декодер отдаёт их в
        // порядке показа, а получает в порядке разжатия.
        const no = Math.round(frame.timestamp);
        const owner = this.owner(decoder);
        if (owner) owner.emitted = Math.max(owner.emitted, no);
        if (this.closed || !this.wanted(no)) {
          frame.close();
          return;
        }
        void this.absorb(no, frame);
      },
      error: (err) => {
        // Декодер уже мёртв; ошибку заберёт тот, кто ждёт кадр, — иначе она
        // осталась бы в консоли, а на экране был бы застывший кадр.
        clipLog("декодер", "ошибка", {
          текущий: this.active?.chunkNo ?? null,
          свой: this.active?.decoder === decoder,
          что: String(err),
        });
        if (this.active?.decoder === decoder) this.active.failure = err;
        this.waiting?.resolve();
      },
    });
    return decoder;
  }

  /** Чей это декодер. Их теперь ровно один: поток идёт через перегоны, и
   *  второй декодер, который прежде грелся к границе, больше не нужен. */
  private owner(decoder: VideoDecoder): Active | null {
    return this.active?.decoder === decoder ? this.active : null;
  }

  /** Снять копию кадра и отпустить буфер декодера.
   *
   * Отпустить надо как можно раньше: пока `VideoFrame` открыт, декодер им
   * занят, и запас у него не бесконечный. Копия живёт своей жизнью и ничего
   * чужого не держит.
   */
  private async absorb(no: number, frame: VideoFrame): Promise<void> {
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(frame);
    } catch (err) {
      clipLog("кольцо", `кадр ${no}: копию снять не вышло —`, String(err));
    } finally {
      frame.close();
    }
    if (!bitmap) return;
    if (this.closed || !this.wanted(no)) {
      bitmap.close();
      return;
    }
    const old = this.ring.get(no);
    if (old) old.close();
    this.ring.set(no, bitmap);
    if (this.waiting?.frameNo === no) this.waiting.resolve();
  }

  private trimRing(around: number) {
    this.keep = { from: around - RING_BEHIND, to: around + RING_AHEAD };
    for (const [no, frame] of [...this.ring]) {
      if (!this.wanted(no)) {
        frame.close();
        this.ring.delete(no);
      }
    }
    // Сколько разжатых кадров держим открытыми — число не праздное. У
    // декодера браузера свой запас буферов, и если держать слишком много
    // кадров незакрытыми, он перестаёт отдавать новые: без ошибки, без
    // события, просто молча. Снаружи это неотличимо от «всё зависло».
    clipLog("кольцо", `вокруг ${around}: открыто ${this.ring.size}`, {
      окно: this.keep,
      очередьДекодера: this.active?.decoder.decodeQueueSize ?? null,
    });
  }
}
