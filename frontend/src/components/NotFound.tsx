import { Link } from "react-router-dom";

/** «Не найдено» по мусорному id в адресе — одинаково на всех страницах.
 *
 *  Раньше одна страница показывала пустой паспорт, другая — тупик без пути
 *  назад, а редактор графа — полноценный холст с активной «Сохранить версию». */
export default function NotFound({ message, back, backLabel }: {
  message: string;
  back: string;
  backLabel: string;
}) {
  return (
    <div className="mag-content">
      <div className="mag-empty-big">
        <b>{message}</b>
        <Link to={back} className="mag-btn">← {backLabel}</Link>
      </div>
    </div>
  );
}

/** Ответ «такого нет»: 404 от сервера. */
export const isMissing = (e: unknown) => (e as { status?: number })?.status === 404;
