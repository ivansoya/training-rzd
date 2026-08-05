import { Link } from "react-router-dom";
import { useProject } from "./ProjectShell";
import { plural } from "./ProjectsPage";

// Обзор: состояние проекта и разметки по классам. Всё остальное живёт
// в своих вкладках, поэтому здесь ничего не режется по месту.
export default function ProjectOverview() {
  const { detail } = useProject();
  const { project, datasets, classes, my_role } = detail;
  const isAdmin = my_role === "admin";
  const importing = project.status === "importing";
  const max = Math.max(1, ...classes.map((c) => c.annotations));

  if (importing) {
    return (
      <div className="mag-import-banner">
        <span className="mag-importing"><i />импорт</span>
        <div>
          <b>Импорт датасета не завершён</b>
          <span>Работа идёт на сервере — вернитесь и продолжите с того же шага.</span>
        </div>
        <Link className="mag-btn mag-btn-inline" to={`/projects/${project.code}/import`}>
          Вернуться к импорту
        </Link>
      </div>
    );
  }

  if (datasets.length === 0) {
    return (
      <div className="mag-card mag-empty-big">
        <h3>В проекте пока нет данных</h3>
        <p>
          Импортируйте YOLO-архив — из него появятся классы, изображения и
          разметка. Участников можно приглашать уже сейчас.
        </p>
        {isAdmin && (
          <Link className="mag-btn mag-btn-inline" to={`/projects/${project.code}/import`}>
            Импортировать датасет
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="mag-card">
      <div className="mag-card-h">
        <h4>Разметки по классам</h4>
        <Link className="mag-ghost mag-ghost-inline" to={`/projects/${project.code}/classes`}>
          Все классы
        </Link>
      </div>
      {classes.length === 0 ? (
        <div className="mag-empty">Классы появятся вместе с первой разметкой.</div>
      ) : (
        classes.slice(0, 12).map((c) => (
          <div key={c.class_index} className="mag-cls">
            <span className="mag-swatch" style={{ background: c.color }} />
            <span className="mag-cls-id">{c.class_index}</span>
            <span className="mag-cls-name">
              <b>{c.name}</b>
              <span>{c.superclass || "без группы"}</span>
            </span>
            <span className="mag-cls-bar">
              <i style={{ width: `${(c.annotations / max) * 100}%`, background: c.color }} />
            </span>
            <span className="mag-cls-n">{c.annotations.toLocaleString("ru-RU")}</span>
          </div>
        ))
      )}
      {classes.length > 12 && (
        <div className="mag-cls-rest">
          и ещё {classes.length - 12}{" "}
          {plural(classes.length - 12, "класс", "класса", "классов")}
        </div>
      )}
    </div>
  );
}
