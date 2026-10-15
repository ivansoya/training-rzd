// События тасок и обучения человеческими словами — одни и те же в истории
// таски и в ленте обзора проекта.

import { count, plural } from "../ru";

// Состояние таски в событии лежит сырым значением; на экране — теми же
// словами, что на карточках (STATUS_LABELS на сервере).
const STATUS_WORD: Record<string, string> = {
  queued: "на очереди",
  in_progress: "в работе",
  done: "готово",
  updating: "изменение",
  closed: "закрыто",
};

const RUN_END: Record<string, string> = {
  done: "завершено",
  stopped: "остановлено",
  error: "упало с ошибкой",
};

/** Глагол прошедшего времени по числу: «принят 1 кадр», «принято 5 кадров». */
const did = (n: number, one: string, many: string) => plural(n, one, many, many);

/** Событие одной строкой; неизвестный вид показывается как есть. */
export function describeTaskEvent(kind: string, payload: Record<string, unknown>): JSX.Element {
  const p = payload as Record<string, string | number>;
  const n = (k: string) => Number(p[k]) || 0;
  const names = (k: string) => (Array.isArray(payload[k]) ? (payload[k] as string[]) : []);
  switch (kind) {
    case "created": {
      // До 12.10.2026 исполнитель был один — старые события несут `assignee`
      const team = names("assignees").length ? names("assignees").join(", ") : p.assignee;
      return <>Таска создана{team ? <>, исполнители — <b>{team}</b></> : ", ничья"}</>;
    }
    case "assigned":
      return <>Исполнитель — <b>{p.assignee ?? "снят"}</b></>;
    case "assignees":
      return (
        <>
          Исполнители:{" "}
          {[...names("added").map((x) => `+ ${x}`), ...names("removed").map((x) => `− ${x}`)].join(", ")}
        </>
      );
    case "images_added":
      return (
        <>
          {did(n("added"), "Загружено", "Загружено")}{" "}
          <b>{count(n("added"), "изображение", "изображения", "изображений")}</b>
          {p.skipped ? `, пропущено ${p.skipped}` : ""}
        </>
      );
    case "video_added":
      return <>Добавлено видео <b>{p.file}</b>{p.mode === "annotate" ? " для разметки" : " для нарезки"}</>;
    case "video_cut":
      return (
        <>
          {did(n("frames"), "Нарезан", "Нарезано")}{" "}
          <b>{count(n("frames"), "кадр", "кадра", "кадров")}</b> из {p.file}, участков: {p.segments}
        </>
      );
    case "videos_handed":
      return (
        <>
          Сданы ролики: новых кадров <b>{n("created")}</b>, обновлено <b>{n("updated")}</b>
          {n("removed") ? `, убрано ${n("removed")}` : ""}
          {n("kept_edited") ? `, правленых в датасете оставлено ${n("kept_edited")}` : ""}
          {n("waiting") + n("unchecked") ? `, ждут проверки агента ${n("waiting") + n("unchecked")}` : ""}
        </>
      );
    // Таска из датасета (решения 14.10.2026): кадры пришли копиями и сданы на место
    case "from_dataset":
      return <>Из датасета <b>+{count(n("added"), "кадр", "кадра", "кадров")}</b></>;
    case "copies_handed":
      return (
        <>
          Сдано в датасет: на место <b>{n("placed")}</b>
          {n("removed") ? <>, убрано из датасета <b>{n("removed")}</b></> : ""}
          {n("edited") ? `, правили в датасете — оставлено ${n("edited")}` : ""}
          {n("waiting") ? `, ждут проверки агента ${n("waiting")}` : ""}
        </>
      );
    // Ручное закрытие разметки убрано 14.10.2026; события остались в истории старых тасок
    case "video_annotation_closed":
      return (
        <>
          Разметка <b>{p.file}</b> закрыта: {count(n("frames"), "кадр", "кадра", "кадров")},{" "}
          {count(n("boxes"), "объект", "объекта", "объектов")}
        </>
      );
    case "video_annotation_reopened":
      return <>Разметка <b>{p.file}</b> открыта заново</>;
    case "video_frames_dropped":
      return (
        <>
          {did(n("removed"), "Убран", "Убрано")}{" "}
          <b>{count(n("removed"), "кадр", "кадра", "кадров")}</b> ролика {p.file}
          {p.kept ? `, оставлено принятых: ${p.kept}` : ""}
        </>
      );
    case "agent_cleared":
      return (
        <>
          Очищено непроверенное агентов: <b>{count(n("boxes"), "рамка", "рамки", "рамок")}</b> на{" "}
          {count(n("frames"), "кадре", "кадрах", "кадрах")}{p.place ? ` — ${p.place}` : ""}
        </>
      );
    case "accepted":
      return (
        <>
          {did(n("accepted"), "Принят", "Принято")}{" "}
          <b>{count(n("accepted"), "кадр", "кадра", "кадров")}</b> в датасет «{p.dataset}»
        </>
      );
    case "done":
      return <>Переведена в готово, принимать было нечего</>;
    case "closed":
      return (
        <>
          Закрыта: {did(n("removed_images"), "удалён", "удалено")}{" "}
          <b>{count(n("removed_images"), "кадр", "кадра", "кадров")}</b>
          {n("removed_videos") ? ` и ${n("removed_videos")} видео` : ""}
        </>
      );
    case "image_deleted":
      return <>Забракован кадр {p.file}</>;
    case "image_restored":
      return <>Кадр {p.file} вернули в работу</>;
    case "class_moved":
      return (
        <>
          Класс разметки сменён: <b>{p.from}</b> → <b>{p.to}</b>
          {p.tracks ? <>, треков: {p.tracks}</> : null}
        </>
      );
    case "status":
      return <>Состояние: <b>{STATUS_WORD[String(p.status)] ?? p.status}</b>{p.joined ? <>, исполнитель — <b>{p.joined}</b></> : null}</>;
    case "agent_accepted":
      return <>Приняты рамки агента на <b>{count(n("count"), "кадре", "кадрах", "кадрах")}</b></>;
    case "run_created":
      return <>Запущено обучение <b>{p.name}</b></>;
    case "run_finished":
      return <>Обучение <b>{p.name}</b> {RUN_END[String(p.status)] ?? "закончилось"}</>;
    default:
      return <>{kind}</>;
  }
}
