import { Navigate, useParams } from "react-router-dom";

/** /projects/X/datasets/<id> — сохранённые ссылки ведут в галерею на группу датасета. */
export function DatasetRedirect() {
  const { code, datasetId } = useParams<{ code: string; datasetId: string }>();
  return <Navigate replace to={`/projects/${code}/datasets?ds=${encodeURIComponent(datasetId ?? "")}`} />;
}
