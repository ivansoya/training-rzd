import { DataStream, MP4BoxBuffer, createFile } from "mp4box";
import type { Sample } from "mp4box";
import { chunkUrl } from "../../auth/api";
import type { ClipChunk, ClipManifest } from "../../auth/api";

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
 * **Разжатыми живут не все.** Перегон целиком в разжатом виде — сотни
 * мегабайт, поэтому держим кольцо вокруг курсора, а остальное закрываем.
 */

// Кадров вокруг курсора держим разжатыми. Шаг стрелкой в обе стороны —
// мгновенный; прыжок дальше требует разжать перегон заново.
const RING_BEHIND = 15;
const RING_AHEAD = 15;
// Насколько вперёд тянем перегоны байтами. Двух хватает с запасом, и это
// дёшево — около мегабайта на перегон. Запас нужен не памяти, а серверу: в
// полном разрешении перегон не нарезан заранее, и запрос заставляет сервер
// резать его на месте — секунды. Спросив пораньше, мы прячем эту работу.
const AHEAD_CHUNKS = 2;
// Сжатых перегонов в памяти: текущий, два следующих и предыдущий.
const CHUNK_CACHE = AHEAD_CHUNKS + 2;

// Прогрев следующего перегона. Притащить его байтами мало: на границе декодер
// пришлось бы заводить с нуля и разжимать цепочку от опорного кадра — на
// 1344×760 это заметная пауза ровно в тот момент, когда ролик идёт. Поэтому за
// WARM_BEFORE кадров до границы заводится второй декодер и разжимает начало
// следующего перегона; к переходу кадры уже лежат в кольце.
//
// Греем только вперёд. Назад ходят рывками, а не потоком, и шаг назад дешёв
// сам по себе: в перегоне пять-шесть опорных кадров, перезапуск стоит десятка.
const WARM_BEFORE = 45;
const WARM_DEPTH = 15;

/** Ступень качества — её идентификатор из манифеста: «src» или высота. */
export type Quality = string;

interface Loaded {
  chunk: ClipChunk;
  codec: string;
  description: Uint8Array;
  /** Кадры в порядке разжатия — том, в каком их надо скармливать декодеру. */
  samples: { data: Uint8Array; key: boolean; cts: number }[];
  /** Время показа → номер кадра внутри перегона. */
  order: Map<number, number>;
}

export class ClipError extends Error {}

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
function demux(bytes: ArrayBuffer): Omit<Loaded, "chunk"> {
  const file = createFile();
  let codec = "";
  let desc: Uint8Array | null = null;
  const samples: Loaded["samples"] = [];
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
      samples.push({ data: new Uint8Array(s.data), key: s.is_sync, cts: s.cts });
    }
  };

  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(bytes, 0), true);
  file.flush();

  if (failure) throw new ClipError(failure);
  if (!desc || !samples.length) throw new ClipError("Перегон разобрать не удалось.");

  // Номер кадра — место в порядке показа, а не в порядке разжатия.
  const order = new Map<number, number>();
  [...samples]
    .sort((a, b) => a.cts - b.cts)
    .forEach((s, i) => order.set(s.cts, i));

  return { codec, description: desc, samples, order };
}

/** Открытый декодер: пока идём по перегону вперёд, он продолжает работать. */
interface Active {
  chunkNo: number;
  quality: Quality;
  decoder: VideoDecoder;
  /** Сколько кадров уже скормлено. */
  fed: number;
  /** После слива декодер снова требует опорный кадр — обычный он не примет. */
  needsKey: boolean;
  /** Ошибка декодера приходит своим ходом; её забирает тот, кто ждёт кадр. */
  failure: Error | null;
}

/** Сколько кадров ждать сверх нужного, прежде чем сливать декодер.
 *
 * Кодировщик переставляет кадры, поэтому декодер отдаёт нужный не сразу:
 * ему надо получить те, на которые тот ссылается. Пока впереди есть чем
 * кормить, слив не нужен — а он дорог тем, что после него нельзя продолжить
 * с обычного кадра. */
const REORDER_SLACK = 4;

export function webCodecsMissing(): boolean {
  return typeof window === "undefined" || typeof window.VideoDecoder === "undefined";
}

export class ClipReader {
  readonly manifest: ClipManifest;
  private taskId: string;
  private videoId: string;
  private quality: Quality;

  private loaded = new Map<string, Loaded>();
  private loading = new Map<string, Promise<Loaded>>();
  private ring = new Map<number, VideoFrame>();
  private active: Active | null = null;
  /** Декодер следующего перегона, заведённый заранее. */
  private ahead: Active | null = null;
  private aheadKeep = { from: 0, to: -1 };
  private warming = false;
  /** Растёт при смене качества. Всё, что начато раньше, в состояние не пишет:
   *  иначе загрузка прежнего качества дописывается в кэш уже после переключения,
   *  и кадр приезжает не тот, что просили. */
  private gen = 0;
  /** Последний запрошенный кадр: по нему видно, что просьба устарела. */
  private latest = -1;
  /** Разжатие идёт по очереди: два декодера на один перегон только мешают. */
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(taskId: string, videoId: string, manifest: ClipManifest) {
    this.taskId = taskId;
    this.videoId = videoId;
    this.manifest = manifest;
    this.quality = manifest.quality || manifest.default_quality;
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
    this.quality = quality;
    this.gen += 1;
    // Картинка другая — и сжатые перегоны, и разжатые кадры больше не годятся.
    this.dropActive();
    this.dropAhead();
    this.loaded.clear();
    this.loading.clear();
    this.ring.forEach((f) => f.close());
    this.ring.clear();
  }

  currentQuality(): Quality {
    return this.quality;
  }

  /** Кадр из кольца, если он там уже есть. Синхронно и без обещаний. */
  peek(frameNo: number): VideoFrame | null {
    return this.ring.get(frameNo) ?? null;
  }

  /** Кадр по номеру. Разжимает столько, сколько нужно, и не больше. */
  frame(frameNo: number): Promise<VideoFrame | null> {
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
      await this.fill(frameNo);
      return this.ring.get(frameNo) ?? null;
    });
  }

  /** Притащить соседние перегоны, пока их не спросили. */
  warm(frameNo: number) {
    const here = this.chunkFor(frameNo);
    if (!here) return;
    const wanted = [here.n - 1];
    for (let i = 1; i <= AHEAD_CHUNKS; i += 1) wanted.push(here.n + i);
    for (const n of wanted) {
      const chunk = this.manifest.chunks[n];
      const key = this.key(n);
      if (chunk && !this.loaded.has(key) && !this.loading.has(key)) void this.load(chunk);
    }
    // Байты — половина дела; у границы заводим ещё и декодер.
    if (here.first + here.count - 1 - frameNo <= WARM_BEFORE) void this.warmAhead(here);
  }

  /** Завести декодер следующего перегона и разжать его начало. */
  private async warmAhead(here: ClipChunk) {
    const next = this.manifest.chunks[here.n + 1];
    if (!next || this.warming || this.closed) return;
    if (this.ahead?.chunkNo === next.n && !this.ahead.failure) return;
    const gen = this.gen;
    this.warming = true;
    try {
      const loaded = await this.load(next);
      // Пока перегон ехал, качество могли переключить: греть его теперь незачем.
      if (this.closed || gen !== this.gen || this.ahead?.chunkNo === next.n) return;
      this.dropAhead();

      const depth = Math.min(next.count, WARM_DEPTH);
      // Держим ровно то, что скормили: кадр, разжатый и тут же закрытый, —
      // выброшенная работа, а на границе он понадобится через мгновение.
      this.aheadKeep = { from: next.first, to: next.first + depth - 1 };
      const decoder = this.makeDecoder(loaded, next);
      this.ahead = {
        chunkNo: next.n,
        quality: this.quality,
        decoder,
        fed: depth,
        needsKey: false,
        failure: null,
      };
      decoder.configure({
        codec: loaded.codec,
        description: loaded.description,
        optimizeForLatency: true,
      });
      for (let i = 0; i < depth; i += 1) {
        const s = loaded.samples[i];
        decoder.decode(
          new EncodedVideoChunk({
            type: s.key ? "key" : "delta",
            timestamp: s.cts,
            data: s.data,
          })
        );
      }
    } catch {
      // Прогрев — ускорение, а не условие работы: перегон всё равно разожмётся
      // обычным путём, просто с паузой.
      this.dropAhead();
    } finally {
      this.warming = false;
    }
  }

  dispose() {
    this.closed = true;
    this.dropActive();
    this.dropAhead();
    this.ring.forEach((f) => f.close());
    this.ring.clear();
    this.loaded.clear();
    this.loading.clear();
  }

  // ----------------------------------------------------------------- частное

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // Очередь не должна вставать из-за одной неудачи.
    this.queue = run.catch(() => undefined);
    return run;
  }

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

    const task = (async () => {
      const res = await fetch(
        chunkUrl(this.taskId, this.videoId, chunk.n, this.quality),
        { credentials: "same-origin" }
      );
      if (!res.ok) {
        throw new ClipError(`Перегон ${chunk.n} не приехал (${res.status}).`);
      }
      // Сервер повторяет в заголовках, какие кадры внутри. Расхождение с
      // манифестом означает, что ролик подменили, и разметка указывает не туда.
      const first = Number(res.headers.get("X-Chunk-First"));
      const count = Number(res.headers.get("X-Chunk-Count"));
      if (first !== chunk.first || count !== chunk.count) {
        throw new ClipError(
          `Перегон ${chunk.n} обещает кадры с ${first} (${count} шт.), ` +
            `а в списке ролика — с ${chunk.first} (${chunk.count} шт.).`
        );
      }
      const parts = demux(await res.arrayBuffer());
      if (parts.samples.length !== chunk.count) {
        throw new ClipError(
          `В перегоне ${chunk.n} разобралось ${parts.samples.length} кадров ` +
            `вместо ${chunk.count}.`
        );
      }
      const loaded: Loaded = { chunk, ...parts };
      // Качество успели переключить, пока перегон ехал: эти байты уже не те,
      // что просят, и в кэш им нельзя — иначе они лягут под новым ключом.
      if (!this.closed && gen === this.gen) {
        this.loaded.set(key, loaded);
        this.trimChunks(chunk.n);
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

  private trimChunks(around: number) {
    if (this.loaded.size <= CHUNK_CACHE) return;
    for (const key of [...this.loaded.keys()]) {
      const [quality, no] = key.split(":");
      // Чужое качество уходит первым: оно уже не понадобится.
      if (quality !== this.quality || Math.abs(Number(no) - around) > AHEAD_CHUNKS) {
        this.loaded.delete(key);
      }
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

  private dropAhead() {
    if (this.ahead) this.shut(this.ahead.decoder);
    this.ahead = null;
    this.aheadKeep = { from: 0, to: -1 };
  }

  private shut(decoder: VideoDecoder) {
    try {
      if (decoder.state !== "closed") decoder.close();
    } catch {
      // Декодер мог закрыться сам после ошибки — это не повод падать.
    }
  }

  /** Нужен ли нам этот кадр: кольцо вокруг курсора плюс прогретое начало
   *  следующего перегона. Всё остальное закрывается сразу. */
  private wanted(no: number): boolean {
    if (no >= this.keep.from && no <= this.keep.to) return true;
    return no >= this.aheadKeep.from && no <= this.aheadKeep.to;
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

  /** Разжать всё, что нужно, чтобы кадр оказался в кольце. */
  private async fill(frameNo: number) {
    const chunk = this.chunkFor(frameNo);
    if (!chunk) throw new ClipError(`Кадра ${frameNo} нет в ролике.`);
    const loaded = await this.load(chunk);
    if (this.closed) return;

    const local = frameNo - chunk.first;
    const upto = Math.min(chunk.count - 1, local + RING_AHEAD);
    this.keep = { from: frameNo - RING_BEHIND, to: frameNo + RING_AHEAD };

    // Идём вперёд по тому же перегону — продолжаем кормить открытый декодер.
    // Назад, в другой перегон или после слива — начинаем с опорного кадра.
    // Условие именно `fed <= local`: если нужный кадр уже скормлен, он либо
    // в кольце (сюда бы не дошли), либо вытеснен — и добыть его можно только
    // заново, сколько декодер ни корми.
    const usable = (a: Active | null): a is Active =>
      a !== null &&
      a.chunkNo === chunk.n &&
      a.quality === this.quality &&
      a.decoder.state === "configured" &&
      !a.needsKey &&
      !a.failure &&
      a.fed <= local;

    let active = this.active;
    if (!usable(active) && usable(this.ahead)) {
      // Дошли до перегона, который грелся заранее: он уже настроен и разжал
      // своё начало — просто становится текущим.
      this.dropActive();
      active = this.ahead;
      this.active = active;
      this.ahead = null;
      this.aheadKeep = { from: 0, to: -1 };
    }

    if (!usable(active)) {
      this.dropActive();
      active = {
        chunkNo: chunk.n,
        quality: this.quality,
        decoder: this.makeDecoder(loaded, chunk),
        fed: this.keyBefore(loaded, local),
        needsKey: false,
        failure: null,
      };
      this.active = active;
      active.decoder.configure({
        codec: loaded.codec,
        description: loaded.description,
        optimizeForLatency: true,
      });
    }

    const current = active!;
    for (let i = current.fed; i <= upto; i += 1) {
      const s = loaded.samples[i];
      current.decoder.decode(
        new EncodedVideoChunk({
          type: s.key ? "key" : "delta",
          timestamp: s.cts,
          data: s.data,
        })
      );
    }
    current.fed = Math.max(current.fed, upto + 1);

    // Ждём именно нужный кадр. Сливать декодер после каждой порции нельзя:
    // после слива он требует опорный кадр, и продолжить проигрывание с
    // обычного уже не выйдет — ровно на этом ломалось проигрывание.
    await this.awaitFrame(frameNo, current, loaded, chunk);
    this.trimRing(frameNo);
  }

  /** Дождаться, пока кадр выйдет из декодера. */
  private async awaitFrame(
    frameNo: number,
    active: Active,
    loaded: Loaded,
    chunk: ClipChunk
  ) {
    if (this.ring.has(frameNo)) return;
    if (active.failure) throw active.failure;

    const local = frameNo - chunk.first;
    // Пока впереди есть чем кормить, декодер отдаст нужный кадр сам: ему
    // осталось получить те, на которые тот ссылается.
    if (active.fed < Math.min(chunk.count, local + REORDER_SLACK + 1)) {
      const more = Math.min(chunk.count - 1, local + REORDER_SLACK);
      for (let i = active.fed; i <= more; i += 1) {
        const s = loaded.samples[i];
        active.decoder.decode(
          new EncodedVideoChunk({
            type: s.key ? "key" : "delta",
            timestamp: s.cts,
            data: s.data,
          })
        );
      }
      active.fed = more + 1;
    }

    await new Promise<void>((resolve) => {
      let timer = 0;
      const done = () => {
        if (this.waiting?.resolve === done) this.waiting = null;
        if (timer) window.clearTimeout(timer);
        resolve();
      };
      // Ждать вечно нельзя: декодер может и промолчать, а разметчик смотрит на
      // застывший кадр. Не дождались — идём сливать.
      timer = window.setTimeout(done, 2000);
      this.waiting = { frameNo, resolve: done };
      // Кадр мог прийти, пока мы сюда добирались.
      if (this.ring.has(frameNo) || active.failure) done();
    });

    if (this.ring.has(frameNo)) return;
    if (active.failure) throw active.failure;

    // Кадр не вышел, хотя всё нужное скормлено, — значит он застрял в
    // конвейере, и достать его можно только сливом. После него декодеру
    // снова нужен опорный кадр, о чём и помечаем.
    if (active.decoder.state === "configured") {
      await active.decoder.flush();
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

  private makeDecoder(loaded: Loaded, chunk: ClipChunk): VideoDecoder {
    const decoder: VideoDecoder = new VideoDecoder({
      output: (frame) => {
        // Номер — из времени показа. Считать выданные кадры нельзя: декодер
        // отдаёт их в порядке показа, а получает в порядке разжатия.
        const local = loaded.order.get(frame.timestamp);
        if (local === undefined) {
          frame.close();
          return;
        }
        const no = chunk.first + local;
        if (this.closed || !this.wanted(no)) {
          frame.close();
          return;
        }
        const old = this.ring.get(no);
        if (old) old.close();
        this.ring.set(no, frame);
        if (this.waiting?.frameNo === no) this.waiting.resolve();
      },
      error: (err) => {
        // Декодер уже мёртв; ошибку заберёт тот, кто ждёт кадр, — иначе она
        // осталась бы в консоли, а на экране был бы застывший кадр.
        if (this.active?.decoder === decoder) this.active.failure = err;
        this.waiting?.resolve();
      },
    });
    return decoder;
  }

  private trimRing(around: number) {
    this.keep = { from: around - RING_BEHIND, to: around + RING_AHEAD };
    for (const [no, frame] of [...this.ring]) {
      if (!this.wanted(no)) {
        frame.close();
        this.ring.delete(no);
      }
    }
  }
}
