import { useEffect, useState } from "react";
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
}: {
  taskId: string;
  videoId: string;
  className?: string;
  style?: CSSProperties;
  draggable?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let live = true;
    let timer = 0;
    let made: string | null = null;

    const ask = async () => {
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
  return (
    <img className={className} src={url} alt="" style={style} draggable={draggable} />
  );
}
