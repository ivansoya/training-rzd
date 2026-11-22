// Файлы мышью на страницу таски: род по типу, папки — со всем вложенным, изображения — частями.

import { useEffect, useState } from "react";
import { count } from "../../ru";

export type Zone = "images" | "cut" | "annotate";
type Kind = "images" | "videos";

/** Что тащат над окном. Имён до броска браузер не даёт — только типы; папка и безымянный тип — `unknown`. */
export interface Dragged { images: number; videos: number; other: number; unknown: boolean }

const IMG_EXT = /\.(jpe?g|png|webp|bmp|tiff?)$/i;
const VID_EXT = /\.(mp4|m4v|mov|mkv|avi|webm|ts|mts|m2ts|hevc|h264|h265)$/i;

/** Род файла: по типу, а где браузер типа не знает — по расширению. */
export function kindOf(f: { name: string; type: string }): Kind | null {
  if (f.type.startsWith("image/") || (!f.type.startsWith("video/") && IMG_EXT.test(f.name))) return "images";
  if (f.type.startsWith("video/") || VID_EXT.test(f.name)) return "videos";
  return null;
}

export const zoneKind = (z: Zone): Kind => (z === "images" ? "images" : "videos");

export function draggedOf(items: ArrayLike<{ kind: string; type: string }>): Dragged {
  const d: Dragged = { images: 0, videos: 0, other: 0, unknown: false };
  for (const it of Array.from(items)) {
    if (it.kind !== "file") continue;
    if (!it.type) d.unknown = true;
    else if (it.type.startsWith("image/")) d.images += 1;
    else if (it.type.startsWith("video/")) d.videos += 1;
    else d.other += 1;
  }
  return d;
}

/** Зона ждёт, пока среди тащимого может быть её род: папку до броска не заглянуть. */
export const fits = (z: Zone, d: Dragged) => d.unknown || d[zoneKind(z)] > 0;

/** Подпись зоны, пока тащат: почему погашена или что будет, если отпустить над ней. */
export function zoneSay(z: Zone, d: Dragged, hover: boolean): string {
  const kind = zoneKind(z);
  if (!fits(z, d)) return kind === "images" ? "Сюда — только изображения" : "Сюда — только видео";
  if (!hover) return "";
  const pure = !d.unknown && !d.other && !d[kind === "images" ? "videos" : "images"];
  if (!pure) return kind === "images" ? "Отпустите — возьму только изображения" : "Отпустите — возьму только ролики";
  const n = d[kind];
  return kind === "images"
    ? `Отпустите — ${count(n, "изображение", "изображения", "изображений")}`
    : `Отпустите — ${count(n, "ролик", "ролика", "роликов")} на ${z === "cut" ? "нарезку" : "разметку"}`;
}

export const PART_FILES = 200;
export const PART_BYTES = 512 * 2 ** 20;

/** Изображения частями [от, до): большое одним запросом не доезжает — сервер дописывает тело после последнего байта. */
export function parts(files: { size: number }[], maxFiles = PART_FILES, maxBytes = PART_BYTES): [number, number][] {
  const out: [number, number][] = [];
  let from = 0, bytes = 0;
  files.forEach((f, i) => {
    if (i > from && (i - from >= maxFiles || bytes + f.size > maxBytes)) {
      out.push([from, i]);
      from = i;
      bytes = 0;
    }
    bytes += f.size;
  });
  if (files.length) out.push([from, files.length]);
  return out;
}

/** Брошенное: файлы и папки со всем вложенным. Записи берутся до первого await — после события браузер список очищает. */
export async function droppedFiles(dt: DataTransfer): Promise<File[]> {
  const loose = Array.from(dt.files);
  // У папок MIME пустой. Для пачки обычных медиафайлов достаточно FileList.
  if (loose.length && loose.length === dt.items.length && loose.every((f) => /^(image|video)\//.test(f.type))) return loose;
  const entries = Array.from(dt.items).filter((i) => i.kind === "file").map((i) => i.webkitGetAsEntry?.() ?? null);
  if (!entries.length || entries.some((e) => !e) ||
    (entries.length === loose.length && entries.every((e) => e?.isFile))) return loose;
  const out: File[] = [];
  for (const e of entries) await walk(e!, out);
  return out;
}

async function walk(e: FileSystemEntry, out: File[]): Promise<void> {
  if (e.isFile) {
    out.push(await new Promise<File>((ok, bad) => (e as FileSystemFileEntry).file(ok, bad)));
    return;
  }
  const reader = (e as FileSystemDirectoryEntry).createReader();
  // readEntries отдаёт папку порциями (в Chrome по 100) — читаем до пустой
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((ok, bad) => reader.readEntries(ok, bad));
    if (!batch.length) return;
    for (let i = 0; i < batch.length;) {
      if (!batch[i].isFile) {
        await walk(batch[i++], out);
        continue;
      }
      const pending: Promise<File>[] = [];
      while (batch[i]?.isFile && pending.length < 32) {
        const entry = batch[i++] as FileSystemFileEntry;
        pending.push(new Promise((ok, bad) => entry.file(ok, bad)));
      }
      out.push(...await Promise.all(pending));
    }
  }
}

/** Тащат ли файлы над окном. Пропало без броска (ушли за окно, Esc) — гаснет само: dragover идёт, пока файл над окном. */
export function useFileDrag(): Dragged | null {
  const [drag, setDrag] = useState<Dragged | null>(null);
  useEffect(() => {
    let active = false;
    let afterDrop = 0;
    const clear = () => {
      active = false;
      setDrag(null);
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) clear();
    };
    const over = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (!dt || (!active && !dt.types.includes("Files"))) return;
      e.preventDefault();
      dt.dropEffect = "none"; // Принимающая зона ниже по дереву выставит copy.
      if (active) return;
      active = true;
      // Для большой пачки проверяем типы при фактическом броске в выбранную зону.
      setDrag(dt.items.length > PART_FILES ? { images: 0, videos: 0, other: 0, unknown: true } : draggedOf(dt.items));
    };
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files") && !e.dataTransfer?.files.length) return;
      e.preventDefault();
      // React ещё должен получить drop на кнопке до снятия наложения.
      window.clearTimeout(afterDrop);
      afterDrop = window.setTimeout(clear, 0);
    };
    window.addEventListener("dragenter", over, true);
    window.addEventListener("dragover", over, true);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragend", clear);
    window.addEventListener("blur", clear);
    window.addEventListener("drop", drop, true);
    return () => {
      window.clearTimeout(afterDrop);
      window.removeEventListener("dragenter", over, true);
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragend", clear);
      window.removeEventListener("blur", clear);
      window.removeEventListener("drop", drop, true);
    };
  }, []);
  return drag;
}
