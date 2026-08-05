import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createTask, listTasks } from "../../auth/api";
import type { TaskSummary } from "../../auth/api";
import { initials } from "../auth/AccountPage";
import { useProject } from "./ProjectShell";
import { plural } from "./ProjectsPage";
import { useEscape } from "./useEscape";

export const TASK_TONE: Record<string, string> = {
  queued: "queued",
  in_progress: "work",
  done: "done",
  updating: "upd",
  closed: "closed",
};

export function TaskState({ status, label }: { status: string; label: string }) {
  return (
    <span className={`mag-tstate ${TASK_TONE[status] || "queued"}`}>
      <i />
      {label}
    </span>
  );
}

export default function ProjectTasks() {
  const { detail } = useProject();
  const navigate = useNavigate();
  const code = detail.project.code;

  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [canCreate, setCanCreate] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await listTasks(code);
      setTasks(d.tasks);
      setCanCreate(d.can_create);
      setIsAdmin(d.is_admin);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [code]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      {error && <div className="mag-error">{error}</div>}

      <div className="mag-card-h">
        <h4 style={{ margin: 0 }}>Таски проекта · {tasks.length}</h4>
        {canCreate && (
          <button className="mag-btn mag-btn-inline" type="button" onClick={() => setShowCreate(true)}>
            Новая таска
          </button>
        )}
      </div>

      {tasks.length === 0 ? (
        <div className="mag-card mag-empty-big">
          <h3>Тасок пока нет</h3>
          <p>
            Таска — это пул кадров, который размечают и по частям отдают в
            проект. Загрузите в неё изображения или видео.
          </p>
          {canCreate && (
            <button className="mag-btn mag-btn-inline" type="button" onClick={() => setShowCreate(true)}>
              Создать первую
            </button>
          )}
        </div>
      ) : (
        <div className="mag-tasks">
          {tasks.map((t) => (
            <Link key={t.id} to={`/projects/${code}/tasks/${t.id}`} className="mag-tcard">
              <div className="mag-tcard-top">
                <h3>{t.name}</h3>
                <TaskState status={t.status} label={t.status_label} />
              </div>
              <p className="mag-tcard-sub">
                {t.counts.total}{" "}
                {plural(t.counts.total, "кадр", "кадра", "кадров")}
                {t.target_dataset ? ` · в датасет «${t.target_dataset.name}»` : ""}
              </p>

              <Progress counts={t.counts} />

              <div className="mag-tcard-foot">
                {t.assignee ? (
                  <>
                    <span className="mag-ava">{initials(t.assignee.display_name)}</span>
                    {t.assignee.display_name}
                  </>
                ) : (
                  <span className="mag-noassignee">без исполнителя</span>
                )}
                <span className="mag-tcard-when">
                  {t.counts.accepted > 0
                    ? `принято ${t.counts.accepted} ${plural(t.counts.accepted, "кадр", "кадра", "кадров")}`
                    : `создана ${new Date(t.created_at).toLocaleDateString("ru-RU")}`}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateTaskModal
          isAdmin={isAdmin}
          onClose={() => setShowCreate(false)}
          onCreated={(id) => navigate(`/projects/${code}/tasks/${id}`)}
        />
      )}
    </>
  );
}

// Полоса из трёх цветов отвечает на главный вопрос без чтения: сколько
// сделано, сколько отложено, сколько ещё не трогали.
export function Progress({ counts }: { counts: TaskSummary["counts"] }) {
  const total = Math.max(1, counts.total);
  return (
    <>
      <div className="mag-tprog">
        <i className="done" style={{ width: `${(counts.annotated / total) * 100}%` }} />
        <i className="skip" style={{ width: `${(counts.skipped / total) * 100}%` }} />
      </div>
      <div className="mag-tlegend">
        <span><i className="done" />{counts.annotated} размечено</span>
        {counts.skipped > 0 && <span><i className="skip" />{counts.skipped} отложено</span>}
        {counts.new > 0 && <span><i className="rest" />{counts.new} не тронуто</span>}
      </div>
    </>
  );
}

function CreateTaskModal({
  isAdmin,
  onClose,
  onCreated,
}: {
  isAdmin: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { detail } = useProject();
  const [name, setName] = useState("");
  const [assignee, setAssignee] = useState("");
  const [dataset, setDataset] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscape(onClose);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const task = await createTask(detail.project.code, {
        name: name.trim(),
        assignee_id: assignee || null,
        target_dataset_id: dataset || null,
      });
      onCreated(task.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mag-backdrop">
      <form className="mag-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h1>Новая таска</h1>
        <p className="mag-sub">
          Кадры попадут в проект, когда вы переведёте таску в «готово».
        </p>
        {error && <div className="mag-error">{error}</div>}

        <div className="mag-field">
          <label htmlFor="nt-name">Название</label>
          <input
            id="nt-name"
            type="text"
            value={name}
            placeholder="Съёмка 12 августа"
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>

        <div className="mag-field">
          <label htmlFor="nt-who">Исполнитель</label>
          <select
            id="nt-who"
            value={assignee}
            disabled={!isAdmin}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <option value="">Я сам</option>
            {isAdmin &&
              detail.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name} · {m.role_label}
                </option>
              ))}
          </select>
          {!isAdmin && (
            <p className="mag-role-hint">Назначать других может администратор.</p>
          )}
        </div>

        <div className="mag-field">
          <label htmlFor="nt-ds">Готовые кадры пойдут в датасет</label>
          <select id="nt-ds" value={dataset} onChange={(e) => setDataset(e.target.value)}>
            <option value="">Новый, с именем таски</option>
            {detail.datasets.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <p className="mag-role-hint">
            Спрашиваем один раз: на «готово» вопросов больше не будет.
          </p>
        </div>

        <div className="mag-modal-foot">
          <button className="mag-ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="mag-btn" type="submit" disabled={busy || !name.trim()}>
            Создать и загрузить кадры
          </button>
        </div>
      </form>
    </div>
  );
}
