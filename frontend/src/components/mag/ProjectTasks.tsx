import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createTask, listTasks } from "../../auth/api";
import type { TaskSummary } from "../../auth/api";
import { initials } from "../auth/AccountPage";
import { useProject } from "./ProjectShell";
import { count, plural } from "../ru";
import { Button, Dialog, Field, Input, Notice, Select } from "../../ui";
import Sep from "../Sep";
import Banner from "../Banner";

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
      {error && <Banner className="mag-error" onClose={() => setError(null)}>{error}</Banner>}

      <div className="mag-card-h">
        <h4 style={{ margin: 0 }}>Таски проекта <Sep /> {tasks.length}</h4>
        {canCreate && (
          <button className="mag-btn mag-btn-inline" type="button" onClick={() => setShowCreate(true)}>
            Новая таска
          </button>
        )}
      </div>

      {tasks.length === 0 ? (
        <div className="mag-card mag-empty-big">
          <h3>Тасок пока нет</h3>
          <p>Загрузите в таску изображения или видео.</p>
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
                {t.target_dataset ? ` — в датасет «${t.target_dataset.name}»` : ""}
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
        {/* Фон — кадр, на котором не нашлось ни одного объекта. Это сделанная
            работа, а не пропуск, и без него полоса не доходила до конца, а
            легенда не сходилась с числом кадров: 94 и 1 при 98 в таске. */}
        <i className="nul" style={{ width: `${(counts.empty / total) * 100}%` }} />
        <i className="skip" style={{ width: `${(counts.skipped / total) * 100}%` }} />
      </div>
      <div className="mag-tlegend">
        <span><i className="done" />{counts.annotated} размечено</span>
        {counts.empty > 0 && <span><i className="nul" />{counts.empty} фон</span>}
        {counts.skipped > 0 && <span><i className="skip" />{counts.skipped} отложено</span>}
        {counts.new > 0 && <span><i className="rest" />{counts.new} не тронуто</span>}
      </div>
    </>
  );
}

export function CreateTaskModal({
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
  // Radix не принимает пустое значение: «me» и «new» — «я сам» и «новый датасет»
  const [assignee, setAssignee] = useState("me");
  const [dataset, setDataset] = useState("new");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const task = await createTask(detail.project.code, {
        name: name.trim(),
        assignee_id: assignee === "me" ? null : assignee,
        target_dataset_id: dataset === "new" ? null : dataset,
      });
      onCreated(task.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const people = isAdmin ? detail.members.filter((m) => m.role !== "viewer") : [];
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }} width={520}
      title="Новая таска" desc="Кадры попадут в проект, когда вы переведёте таску в «Готово»."
      footer={
        <>
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={() => submit()}>Создать и загрузить кадры</Button>
        </>
      }>
      <form className="stack-v" style={{ gap: 14 }} onSubmit={submit}>
        {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
        <Field label="Название">
          {(id) => <Input id={id} value={name} placeholder="Съёмка 12 августа" maxLength={255} data-autofocus
            onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Исполнитель" hint={isAdmin ? undefined : "Назначать других может администратор."}>
          {(id) => <Select id={id} full value={assignee} onChange={setAssignee} disabled={!isAdmin} label="Исполнитель"
            options={[{ value: "me", label: "Я сам" },
              ...people.map((m) => ({ value: m.id, label: m.display_name, hint: m.role_label }))]} />}
        </Field>
        <Field label="Готовые кадры пойдут в датасет" hint="Спрашиваем один раз: на «Готово» вопросов больше не будет.">
          {(id) => <Select id={id} full value={dataset} onChange={setDataset} label="Датасет для готовых кадров"
            options={[{ value: "new", label: "Новый, с именем таски", hint: name.trim() ? `«${name.trim()}»` : "имя появится вместе с названием таски" },
              ...detail.datasets.map((d) => ({ value: d.id, label: d.name, hint: count(d.images_count, "кадр", "кадра", "кадров") }))]} />}
        </Field>
        {/* Enter в названии создаёт таску */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
