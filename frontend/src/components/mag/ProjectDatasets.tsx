import { Link } from "react-router-dom";
import { useProject } from "./ProjectShell";

// Вкладка «Датасеты». Таблица получила собственный класс: правила кабинета
// (.mag-cab table) сюда никогда не доставали, поэтому она была без стилей.
export default function ProjectDatasets() {
  const { detail } = useProject();
  const { project, datasets, my_role } = detail;

  if (datasets.length === 0) {
    return (
      <div className="mag-card mag-empty-big">
        <h3>Датасетов пока нет</h3>
        <p>Импортируйте YOLO-архив — он станет первым датасетом проекта.</p>
        {my_role === "admin" && (
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
        <h4>Датасеты проекта</h4>
      </div>
      <div className="mag-table-scroll">
        <table className="mag-table">
          <thead>
            <tr>
              <th>Название</th>
              <th>Идентификатор</th>
              <th className="num">Изображений</th>
              <th>Создан</th>
            </tr>
          </thead>
          <tbody>
            {datasets.map((d) => (
              <tr key={d.id}>
                <td>
                  <Link
                    className="mag-link"
                    to={`/projects/${project.code}/datasets/${d.id}`}
                  >
                    {d.name}
                  </Link>
                </td>
                <td><span className="mag-code">{d.identifier}</span></td>
                <td className="num">{d.images_count.toLocaleString("ru-RU")}</td>
                <td>{new Date(d.created_at).toLocaleDateString("ru-RU")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
