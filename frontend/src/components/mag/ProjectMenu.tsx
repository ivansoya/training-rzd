import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { deleteProject, getProjectCost, removeMember, updateProject } from "../../auth/api";
import type { ProjectCost, ProjectDetail } from "../../auth/api";
import { Button, Dialog, Field, Input, MenuItem, Notice, Popover, Textarea } from "../../ui";
import { useAuth } from "../auth/AuthGate";
import { count } from "../ru";
import { useAction } from "./classes/useAction";

type Open = "settings" | "leave" | "delete" | null;

/** «⋯» в шапке обзора: настройки проекта, выход и удаление. */
export function ProjectMenu({ detail, refresh }: { detail: ProjectDetail; refresh: () => Promise<void> }) {
  const [open, setOpen] = useState<Open>(null);
  const isAdmin = detail.my_role === "admin";
  const { project } = detail;
  const close = () => setOpen(null);
  return (
    <>
      <Popover align="end" width={240}
        trigger={<Button icon="more" aria-label="Действия с проектом" title="Действия с проектом" />}>
        {(hide) => (
          <>
            {isAdmin && (
              <MenuItem icon="settings" onSelect={() => { hide(); setOpen("settings"); }}>Настройки проекта…</MenuItem>
            )}
            <MenuItem icon="logout" onSelect={() => { hide(); setOpen("leave"); }}>Выйти из проекта…</MenuItem>
            {isAdmin && (
              <>
                <div className="ui-pop-sep" />
                <MenuItem icon="trash" danger onSelect={() => { hide(); setOpen("delete"); }}>Удалить проект…</MenuItem>
              </>
            )}
          </>
        )}
      </Popover>
      {open === "settings" && (
        <SettingsDialog code={project.code} name={project.name} description={project.description}
          onClose={close} onSaved={refresh} />
      )}
      {open === "leave" && <LeaveDialog code={project.code} name={project.name} onClose={close} />}
      {open === "delete" && <DeleteDialog code={project.code} name={project.name} onClose={close} />}
    </>
  );
}

/** Название и описание. Код не меняется: он в ссылках и выгрузках. */
function SettingsDialog({ code, name, description, onClose, onSaved }: {
  code: string; name: string; description: string | null; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const { refresh: refreshMe } = useAuth();
  const [draft, setDraft] = useState({ name, description: description ?? "" });
  const { busy, error, run } = useAction();
  const changed = draft.name.trim() !== name || draft.description.trim() !== (description ?? "");
  const ready = changed && Boolean(draft.name.trim()) && !busy;

  const save = (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    void run(async () => {
      await updateProject(code, { name: draft.name.trim(), description: draft.description.trim() });
      // Имя проекта в сайдбаре и переключателе берётся из me
      await Promise.all([onSaved(), refreshMe()]);
      onClose();
    });
  };

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }} width={520} modalLock={changed}
      title="Настройки проекта" desc={<>Код <span className="ui-mono">{code}</span> не меняется: на нём держатся ссылки и выгрузки.</>}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" disabled={!ready} onClick={() => save()}>{busy ? "Сохраняем…" : "Сохранить"}</Button>
      </>}>
      <form className="stack-v np-form" onSubmit={save}>
        {error && <Notice tone="error">{error}</Notice>}
        <Field label="Название">
          {(id) => <Input id={id} value={draft.name} maxLength={255} data-autofocus
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />}
        </Field>
        <Field label="Описание" hint="Что размечаем и зачем.">
          {(id) => <Textarea id={id} rows={3} value={draft.description} maxLength={5000}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />}
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function LeaveDialog({ code, name, onClose }: { code: string; name: string; onClose: () => void }) {
  const { me, refresh: refreshMe } = useAuth();
  const navigate = useNavigate();
  const { busy, error, run } = useAction();
  const leave = () => run(async () => {
    await removeMember(code, me.user.id);
    await refreshMe();
    navigate("/", { replace: true });
  });
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }} width={440}
      title={`Выйти из проекта «${name}»`}
      desc="Проект пропадёт из вашего списка. Вернуться можно только по новому приглашению."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="danger" icon="logout" disabled={busy} onClick={leave} data-autofocus>Выйти</Button>
      </>}>
      {error && <Notice tone="error">{error}</Notice>}
    </Dialog>
  );
}

// Сначала цена — что уйдёт вместе с проектом, — потом набрать название: на «Вы уверены?» жмут не читая.
function DeleteDialog({ code, name, onClose }: { code: string; name: string; onClose: () => void }) {
  const { refresh: refreshMe } = useAuth();
  const navigate = useNavigate();
  const [cost, setCost] = useState<ProjectCost | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const { busy, error, run } = useAction();

  useEffect(() => {
    getProjectCost(code).then(setCost).catch((e) => setFailed((e as Error).message));
  }, [code]);

  const ready = cost !== null && !cost.busy && typed.trim() === name.trim() && !busy;
  const remove = (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    void run(async () => {
      await deleteProject(code);
      await refreshMe();
      navigate("/", { replace: true });
    });
  };

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }} width={520} modalLock={typed !== ""}
      title={`Удалить проект «${name}»`}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="danger" icon="trash" disabled={!ready} onClick={() => remove()}>
          {busy ? "Удаляем…" : "Удалить навсегда"}
        </Button>
      </>}>
      <form className="stack-v np-form" onSubmit={remove}>
        {(failed || error) && <Notice tone="error">{failed ?? error}</Notice>}
        {cost === null ? (
          !failed && <p className="t-sm t-muted">Считаем, что уйдёт…</p>
        ) : (
          <>
            <p className="t-sm">
              Вместе с проектом безвозвратно уйдут {count(cost.images, "кадр", "кадра", "кадров")},{" "}
              {count(cost.annotations, "разметка", "разметки", "разметок")},{" "}
              {count(cost.tasks, "таска", "таски", "тасок")},{" "}
              {count(cost.train_sets, "обучающий набор", "обучающих набора", "обучающих наборов")} и{" "}
              {count(cost.train_runs, "обучение", "обучения", "обучений")} с весами.
            </p>
            {cost.busy && (
              <Notice tone="warn">Сейчас в проекте {cost.busy}. Дождитесь окончания или остановите работу.</Notice>
            )}
          </>
        )}
        <Field label="Введите название проекта">
          {(id) => <Input id={id} value={typed} autoComplete="off" placeholder={name} data-autofocus
            onChange={(e) => setTyped(e.target.value)} />}
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
