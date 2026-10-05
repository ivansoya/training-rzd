import { Navigate, useParams } from "react-router-dom";

/** /projects/X/training/runs/<uuid> — старые ссылки ведут на страницу прогона; номер подставит она сама. */
export function RunRedirect() {
  const { code, runId } = useParams<{ code: string; runId: string }>();
  return <Navigate replace to={`/projects/${code}/runs/${encodeURIComponent(runId ?? "")}`} />;
}
