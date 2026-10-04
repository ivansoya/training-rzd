// Арифметика галереи кадров без DOM: раскладка плиток, видимые ряды, состояние кадра.

/** Плитка 4:3 — кадры с камер 1920×1400; 16:9 из макета срезал низ кадра, где часто рамки. */
export const TILE_RATIO = 4 / 3;
export const GAP = 6;

export interface GridLayout {
  cols: number;
  tileW: number;
  rowH: number;
  /** Шаг ряда: высота плюс зазор. */
  stride: number;
}

/** Сколько плиток не уже `minTile` влезает в ширину и какого они размера. */
export function gridLayout(width: number, minTile: number, gap = GAP): GridLayout {
  const cols = Math.max(1, Math.floor((width + gap) / (minTile + gap)));
  const tileW = Math.max(1, (width - gap * (cols - 1)) / cols);
  const rowH = tileW / TILE_RATIO;
  return { cols, tileW, rowH, stride: rowH + gap };
}

/** Ряды, попавшие в окно (с запасом), по положению верха сетки относительно окна. */
export function visibleRows(top: number, viewH: number, stride: number, rows: number, overscan = 3): [number, number] {
  if (rows <= 0 || stride <= 0) return [0, 0];
  const first = Math.floor(-top / stride) - overscan;
  const last = Math.ceil((viewH - top) / stride) + overscan;
  const start = Math.min(rows, Math.max(0, first));
  return [start, Math.max(start, Math.min(rows, last))];
}

export type FrameState = "done" | "empty" | "skip" | "new";

export const FRAME_STATE: Record<FrameState, { label: string; color: string }> = {
  done: { label: "Размечен", color: "var(--st-done)" },
  empty: { label: "Пусто", color: "var(--st-empty)" },
  skip: { label: "Отложен", color: "var(--st-skip)" },
  new: { label: "Без разметки", color: "var(--st-new)" },
};

/** Состояние кадра данных. Кадры архива приходят с «new», хотя размечены, — решает рамка. */
export function frameState(taskStatus: string | undefined, objects: number): FrameState {
  if (taskStatus === "skipped") return "skip";
  if (objects > 0) return "done";
  if (taskStatus === "empty") return "empty";
  return "new";
}
