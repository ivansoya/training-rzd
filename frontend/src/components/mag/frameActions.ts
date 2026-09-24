import type { ImageTaskStatus } from "../../auth/api";

export type FrameAction = "accept" | "empty" | "skip" | "trash" | "restore" | "next";

/** Что можно сделать с кадром прямо сейчас — только это и стоит на плашке.
 *
 * Решение владельца (24.09.2026): кнопка, которую нельзя нажать, на плашке не
 * нужна, погашенная тоже. «Пусто» при объектах на кадре нет: фоновый кадр с
 * объектом — противоречие, и редактор ролика его так же не пускает. Снять уже
 * стоящую пометку можно всегда. «Далее →» есть всегда, листать можно и в
 * закрытой таске.
 */
export function frameActions(frame: {
  status: ImageTaskStatus;
  /** Объектов на кадре сейчас, с неспасёнными правками. */
  objects: number;
  /** Новый кадр с нетронутыми рамками агента. */
  agentFrame: boolean;
  readOnly: boolean;
}): FrameAction[] {
  if (frame.readOnly) return ["next"];
  if (frame.status === "deleted") return ["restore", "next"];
  const out: FrameAction[] = [];
  if (frame.agentFrame) out.push("accept");
  if (frame.objects === 0 || frame.status === "empty") out.push("empty");
  out.push("skip", "trash", "next");
  return out;
}
