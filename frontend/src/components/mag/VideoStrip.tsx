import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { videoStripUrl } from "../../auth/api";

/** Кинолента ролика — картинка, которой может ещё не быть.
 *
 * Раньше это был обычный `<img src>`, а сервер клеил ленту прямо в запросе.
 * На двадцатиминутном ролике это два десятка перемоток по исходнику: браузер
 * успевал оборвать соединение, и на месте ленты оставался значок битой
 * картинки — навсегда, потому что `<img>` второй раз не ходит.
 *
 * Теперь ленту клеит воркер, а сервер отвечает «готовится». Ждём и
 * заглядываем снова; пока ждём — светлая заглушка, а не сломанная картинка.
 */
export default function VideoStrip({
  taskId,
  videoId,
  className,
  style,
  draggable,
  aspect,
}: {
  taskId: string;
  videoId: string;
  className?: string;
  style?: CSSProperties;
  draggable?: boolean;
  /** Пропорция кадра ролика (ширина к высоте). С ней лента ложится на шкалу
   *  ролика: i-й кадр ленты — на i-ю долю ширины. Без неё — просто картинка
   *  (постер). */
  aspect?: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let live = true;
    let timer = 0;
    let made: string | null = null;
    // Предел ожидания: ролик, который не клеится, не должен опрашиваться вечно.
    let tries = 0;

    const ask = async () => {
      if (++tries > 80) {
        if (live) setGone(true);
        return;
      }
      try {
        const res = await fetch(videoStripUrl(taskId, videoId));
        if (!live) return;
        if (res.status === 202) {
          const body = await res.json().catch(() => ({}));
          timer = window.setTimeout(ask, Number(body.retry_after_ms) || 1500);
          return;
        }
        if (!res.ok) {
          setGone(true);
          return;
        }
        made = URL.createObjectURL(await res.blob());
        if (!live) {
          URL.revokeObjectURL(made);
          return;
        }
        setUrl(made);
      } catch {
        // Сеть моргнула — попробуем ещё раз; лента не то, ради чего стоит
        // показывать человеку ошибку.
        if (live) timer = window.setTimeout(ask, 3000);
      }
    };
    void ask();

    return () => {
      live = false;
      if (timer) window.clearTimeout(timer);
      if (made) URL.revokeObjectURL(made);
    };
  }, [taskId, videoId]);

  if (gone) return <span className={`${className || ""} g-strip-none`} style={style} />;
  if (!url) return <span className={`${className || ""} g-strip-wait`} style={style} />;
  if (aspect) return <ScaleStrip url={url} aspect={aspect} className={className} style={style} />;
  return (
    <img className={className} src={url} alt="" style={style} draggable={draggable} />
  );
}

/** Лента, разложенная по шкале.
 *
 * Лента — двадцать кадров встык (160×90 у ролика 16:9), а ячейка под ней
 * втрое шире по пропорции. `object-fit: cover` показывал только середину
 * ленты, и участки на шкале ложились на чужие кадры; растянуть целиком
 * значило бы сплющить каждый кадр втрое. Поэтому кадры раскладываются по
 * одному: i-й — в i-ю долю ширины, с обрезкой по краям своей доли, как
 * плитки `WindowStrip` при приближении. Число кадров — из ширины ленты и
 * пропорции ролика: сервер клеит их одинаковой ширины. */
function ScaleStrip({
  url, aspect, className, style,
}: {
  url: string;
  aspect: number;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const img = new Image();
    const draw = () => {
      const box = canvas.getBoundingClientRect();
      if (!img.naturalWidth || !box.width || !box.height) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(box.width * dpr);
      canvas.height = Math.round(box.height * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const n = Math.max(1, Math.round(img.naturalWidth / (img.naturalHeight * aspect)));
      const tw = img.naturalWidth / n;
      const th = img.naturalHeight;
      const w = canvas.width / n;
      const h = canvas.height;
      const k = Math.max(w / tw, h / th);
      const sw = w / k;
      const sh = h / k;
      for (let i = 0; i < n; i += 1) {
        ctx.drawImage(img, i * tw + (tw - sw) / 2, (th - sh) / 2, sw, sh, i * w, 0, w, h);
      }
    };
    img.onload = draw;
    img.src = url;
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => {
      img.onload = null;
      ro.disconnect();
    };
  }, [url, aspect]);
  return <canvas ref={ref} className={className} style={style} />;
}
