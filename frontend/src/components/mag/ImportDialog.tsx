import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { pollJob } from "../../api/jobs";
import { cancelImport, commitImport, getClasses, getImport } from "../../auth/api";
import type { ImportState, LabelClass, ScannedClass } from "../../auth/api";
import { Button, ColorPicker, Dialog, Field, Icon, Input, LinkButton, Pill, Popover, Ring, Select } from "../../ui";
import { count, plural, ru } from "../ru";
import { clearUpload, startUpload, useUpload } from "./importUpload";
import ProjectOverview from "./ProjectOverview";
import { formatBytes, useProject } from "./ProjectShell";
import { roleAtLeast, useProjectRole } from "./useProjectRole";

// Цвета для классов без своего — тот же список, что у сервера: класс выглядит
// одинаково до записи и после.
const PALETTE = [
  "#e5484d", "#0090ff", "#f76b15", "#29a383", "#6e56cf", "#00a2c7",
  "#d6409f", "#3e63dd", "#ffc53d", "#46a758", "#8e4ec6", "#7ce2fe",
];
const STEPS = ["Загрузка", "Разбор", "Классы", "Запись"];

interface ClassDraft {
  name: string;
  color: string;
  superclass: string | null;
  /** Класс проекта, в который ляжет разметка; null — завести новый. */
  target: string | null;
}

const norm = (s: string) => s.trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е");

/** Мастер импорта YOLO-архива в окне одного размера на всех шагах.
 *  Состояние живёт на сервере: закрытое окно и перезагрузка не теряют начатое. */
export default function ImportDialog({ onClose }: { onClose: () => void }) {
  const { code } = useParams<{ code: string }>();
  const role = useProjectRole(code);
  const upload = useUpload(code);
  const { detail: projectDetail, refresh: refreshProject } = useProject();
  const projectName = projectDetail.project.name;

  const [state, setState] = useState<ImportState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobPct, setJobPct] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  // Отчёт разбора — свой шаг: сервер сразу переходит к классам, человек — после прочтения
  const [reportSeen, setReportSeen] = useState(false);
  const [datasetName, setDatasetName] = useState("");
  const [drafts, setDrafts] = useState<Record<number, ClassDraft>>({});
  const [superclasses, setSuperclasses] = useState<{ name: string; color: string }[]>([]);
  const [newSuperclass, setNewSuperclass] = useState("");
  // Классы проекта: архив сверяется с ними, их номера не меняются
  const [projectClasses, setProjectClasses] = useState<LabelClass[] | null>(null);
  const [projectSupers, setProjectSupers] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const following = useRef<string | null>(null);
  // «Готово» показываем, только если запись кончилась при открытом окне; старый
  // итог не мешает начать следующий импорт — он остаётся бейджем у выбора архива
  const [liveDone, setLiveDone] = useState(false);

  const refresh = useCallback(async () => {
    if (!code) return null;
    const next = await getImport(code);
    setState(next);
    return next;
  }, [code]);

  // Следит за фоновой задачей до конца и перечитывает состояние мастера
  const follow = useCallback(async (jobId: string) => {
    if (following.current === jobId) return;
    following.current = jobId;
    try {
      await pollJob(jobId, (job) => setJobPct(job.total ? job.processed / job.total : null));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      following.current = null;
      setJobPct(null);
      const next = await refresh().catch(() => null);
      if (next?.status === "done") setLiveDone(true);
    }
  }, [refresh]);

  // При открытии — подхватить то, что делает сервер
  useEffect(() => {
    refresh()
      .then((next) => {
        if (next && (next.status === "scanning" || next.status === "writing") && next.job_id) void follow(next.job_id);
      })
      .catch((e) => setError((e as Error).message));
  }, [refresh, follow]);

  // Загрузка, начатая до закрытия окна, закончилась — к разбору
  useEffect(() => {
    if (!code || !upload?.done) return;
    clearUpload(code);
    if ("job_id" in upload.done) {
      void refresh().then(() => follow((upload.done as { job_id: string }).job_id));
    } else {
      // Ответ мог потеряться, а на сервере архив уже разбирается: верим серверу
      const message = upload.done.error;
      void refresh().then((next) => {
        if (next?.status === "scanning" && next.job_id) void follow(next.job_id);
        else setError(message);
      });
    }
  }, [code, upload?.done, refresh, follow]);

  // Импорт записан — оболочка проекта перечитывает паспорт: датасет, классы и счёт кадров новые
  useEffect(() => {
    if (state?.status === "done") void refreshProject();
  }, [state?.status, refreshProject]);

  useEffect(() => {
    if (!code || state?.status !== "classes" || projectClasses) return;
    getClasses(code)
      .then((info) => {
        setProjectClasses(info.classes);
        setProjectSupers(info.superclasses.map((sc) => sc.name));
      })
      .catch((e) => setError((e as Error).message));
  }, [code, state?.status, projectClasses]);

  // Шаг классов начинается с того, что сказал архив; одноимённый класс проекта сопоставлен сразу
  useEffect(() => {
    if (state?.status !== "classes" || !state.report || !projectClasses) return;
    setDatasetName((prev) => prev || state.archive?.name.replace(/\.zip$/i, "") || "");
    setDrafts((prev) => {
      if (Object.keys(prev).length) return prev;
      const next: Record<number, ClassDraft> = {};
      const byName = new Map(projectClasses.map((pc) => [norm(pc.name), pc.id]));
      state.report!.classes.forEach((c, i) => {
        next[c.class_index] = {
          name: c.yaml_name || "",
          color: PALETTE[i % PALETTE.length],
          superclass: null,
          target: c.yaml_name ? byName.get(norm(c.yaml_name)) ?? null : null,
        };
      });
      return next;
    });
  }, [state, projectClasses]);

  function handleFile(file: File) {
    if (!code) return;
    setError(null);
    setReportSeen(false);
    startUpload(code, file).catch(() => undefined);
  }

  async function handleCommit() {
    if (!code || !state?.report) return;
    setBusy(true);
    setError(null);
    try {
      const { job_id } = await commitImport(code, {
        dataset_name: datasetName.trim(),
        superclasses,
        classes: state.report.classes.map((c) => {
          const d = drafts[c.class_index];
          return d?.target
            ? { class_index: c.class_index, target: d.target }
            : {
                class_index: c.class_index,
                name: (d?.name || "").trim(),
                color: d?.color || PALETTE[0],
                superclass: d?.superclass || null,
              };
        }) as never,
      });
      await refresh();
      void follow(job_id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!code) return;
    try {
      await cancelImport(code);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setConfirmCancel(false);
    }
  }

  /** После ошибки: убрать её следы на сервере и начать с выбора архива. */
  async function handleRestart() {
    if (!code) return;
    try {
      await cancelImport(code);
      setError(null);
      setDrafts({});
      setReportSeen(false);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function addSuperclass() {
    const name = newSuperclass.trim();
    if (!name || superclasses.some((s) => norm(s.name) === norm(name)) || projectSupers.some((s) => norm(s) === norm(name))) return;
    setSuperclasses((prev) => [...prev, { name, color: PALETTE[(prev.length + 3) % PALETTE.length] }]);
    setNewSuperclass("");
  }

  const dialog = (props: { step: number | "done"; bad?: boolean; body: ReactNode; footer: ReactNode }) => (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }} width={780} height={640} className="imp"
      title="Импорт архива" desc={`YOLO-архив станет датасетом проекта «${projectName}»`}
      above={<Steps step={props.step} bad={props.bad} />}
      footer={props.footer}>
      {error && <Pill tone="bad">{error}</Pill>}
      {props.body}
    </Dialog>
  );

  // Мастер без нужной роли — объяснение сразу, а не 403 на последней кнопке
  if (!roleAtLeast(role, "admin")) {
    return dialog({
      step: 0,
      body: <Stage ring={<Ring tone="bad" label="Нет прав" />} title="Импортировать архив может администратор проекта" />,
      footer: <><span className="grow" /><Button variant="ghost" onClick={onClose}>Закрыть</Button></>,
    });
  }

  const cancelBtn = confirmCancel ? (
    <span className="imp-confirm">
      <span className="t-sm">Отменить импорт? Загруженный архив будет удалён.</span>
      <Button variant="danger" size="sm" onClick={handleCancel}>Да, отменить</Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirmCancel(false)}>Нет</Button>
    </span>
  ) : <Button variant="danger" onClick={() => setConfirmCancel(true)}>Отменить импорт</Button>;
  const fold = <Button variant="ghost" icon="fit" onClick={onClose}>Свернуть</Button>;

  if (!state) {
    return dialog({ step: 0, body: <Stage ring={<Ring value={0} label="Загрузка состояния" />} title="Смотрю, что с импортом…" />, footer: <span className="grow" /> });
  }

  // --- 1. Загрузка: идёт в этой вкладке ---
  if (upload && !upload.done) {
    const starting = upload.pct >= 0.999;
    return dialog({
      step: 0,
      body: <Stage ring={<Ring value={upload.pct} label="Загрузка архива" />}
        title={starting ? "Запускаю разбор архива…" : "Передаю архив"}
        sub={<>{upload.name} · <span className="ui-mono">{formatBytes(upload.size * upload.pct)} из {formatBytes(upload.size)}</span></>}
        pills={<Pill icon="refresh">Докачается при обрыве — выберите тот же файл</Pill>} />,
      footer: <>{cancelBtn}<span className="grow" />{!confirmCancel && fold}</>,
    });
  }

  // --- 1. Выбор архива ---
  const stale = state.status === "done" && !liveDone;
  if (state.status === "none" || state.status === "uploading" || stale) {
    const broken = state.status === "uploading" && state.upload?.name;
    return dialog({
      step: 0,
      body: (
        <div className="imp-stage">
          {(
            <>
              <label className="imp-drop" onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}>
                <Icon name="upload" size={24} />
                <b>Перетащите zip сюда или выберите файл</b>
                <span>YOLO-архив: data.yaml, images/, labels/</span>
                <span className="ui-btn ui-btn-outline">{broken ? "Выбрать архив снова" : "Выбрать архив"}</span>
                <input ref={fileInput} type="file" accept=".zip" hidden
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
              </label>
              <div className="ui-pills imp-center">
                {broken ? (
                  <Pill tone="warn" icon="refresh">
                    Загрузка «{state.upload!.name}» оборвалась на {Math.round(((state.upload!.received ?? 0) / Math.max(1, state.upload!.size ?? 1)) * 100)} % — выберите тот же файл
                  </Pill>
                ) : (
                  <>
                    {stale && state.result && (
                      <Pill tone="ok">Прошлый импорт: «{state.dataset_name}», {count(state.result.images, "изображение", "изображения", "изображений")}</Pill>
                    )}
                    <Pill>Размер не ограничен</Pill>
                    <Pill icon="refresh">Докачается при обрыве</Pill>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      ),
      footer: <>{broken && cancelBtn}<span className="grow" />{!confirmCancel && <Button variant="ghost" onClick={onClose}>Закрыть</Button>}</>,
    });
  }

  // --- 2. Разбор идёт ---
  if (state.status === "scanning") {
    return dialog({
      step: 1,
      body: <Stage ring={<Ring value={jobPct ?? 0} label="Разбор архива" />} title="Разбираю разметку"
        sub="Читаю классы и размеры изображений" pills={<Pill>Окно можно закрыть — разбор идёт на сервере</Pill>} />,
      footer: <>{cancelBtn}<span className="grow" />{!confirmCancel && fold}</>,
    });
  }

  const report = state.report;

  // --- 2. Отчёт разбора ---
  if (state.status === "classes" && report && !reportSeen) {
    const splits = ["train", "val", "test", "other"].filter((k) => report.splits[k]);
    return dialog({
      step: 1,
      body: (
        <>
          <div className="imp-stats">
            <Stat value={ru(report.archive_members)} label={plural(report.archive_members, "файл в архиве", "файла в архиве", "файлов в архиве")} />
            <Stat value={ru(report.images)} label={plural(report.images, "изображение", "изображения", "изображений")} />
            <Stat value={splits.length ? splits.map((k) => ru(report.splits[k])).join(" / ") : "—"}
              label={splits.length ? splits.map((k) => (k === "other" ? "вне сплитов" : k)).join(" / ") : "сплитов нет"} />
            <Stat value={ru(report.annotations)} label={plural(report.annotations, "разметка", "разметки", "разметок")} />
          </div>
          <div className="ui-pills">
            <Pill>{count(report.classes.length, "идентификатор класса", "идентификатора класса", "идентификаторов класса")}</Pill>
            {report.images_without_labels > 0 && <Pill>{count(report.images_without_labels, "изображение", "изображения", "изображений")} без разметки</Pill>}
            {report.clipped > 0 && <Pill tone="warn">{count(report.clipped, "объект подрезан", "объекта подрезано", "объектов подрезано")} по кадру</Pill>}
            {report.skipped > 0 && <Pill tone="bad">{count(report.skipped, "изображение пропущено", "изображения пропущено", "изображений пропущено")}</Pill>}
          </div>
          {report.skipped_examples.length > 0 && (
            <div className="imp-skips">
              <div className="imp-skips-h">Пропущено</div>
              {report.skipped_examples.map((s) => <span key={s.file}><code>{s.file}</code> — {s.reason}</span>)}
              {report.skipped > report.skipped_examples.length && (
                <span className="t-faint">…и ещё {report.skipped - report.skipped_examples.length}</span>
              )}
            </div>
          )}
        </>
      ),
      footer: <>{cancelBtn}<span className="grow" />{!confirmCancel && <Button variant="primary" onClick={() => setReportSeen(true)}>К классам</Button>}</>,
    });
  }

  // --- 3. Классы ---
  if (state.status === "classes" && report) {
    const fresh = report.classes.filter((c) => !drafts[c.class_index]?.target);
    const unnamed = fresh.filter((c) => !(drafts[c.class_index]?.name || "").trim()).length;
    const taken = new Set((projectClasses ?? []).map((pc) => norm(pc.name)));
    const clash = fresh.map((c) => (drafts[c.class_index]?.name || "").trim())
      .filter((n) => n && taken.has(norm(n)));
    const mapped = report.classes.length - fresh.length;
    const maxCount = Math.max(1, ...report.classes.map((c) => c.annotations));
    const merge = (projectClasses?.length ?? 0) > 0;
    const supers = [...projectSupers, ...superclasses.map((sc) => sc.name)];
    return dialog({
      step: 2,
      body: (
        <>
          <Field label="Название датасета">
            {(id) => <Input id={id} value={datasetName} placeholder="Как называть эту партию изображений"
              onChange={(e) => setDatasetName(e.target.value)} />}
          </Field>
          <div className="stack-v">
            <span className="imp-l">Классы и суперклассы</span>
            <div className="ui-pills">
              {merge && <Pill>{mapped
                ? `${count(mapped, "класс сопоставлен", "класса сопоставлено", "классов сопоставлено")} с проектом`
                : "Ни один класс не сопоставлен с проектом"}</Pill>}
              {clash.length > 0 && <Pill tone="bad">Имя «{clash[0]}» уже есть в проекте — сопоставьте с ним</Pill>}
              {unnamed
                ? <Pill tone="warn">{count(unnamed, "класс", "класса", "классов")} без названия</Pill>
                : !clash.length && <Pill tone="ok">Все классы названы</Pill>}
            </div>
          </div>
          <div className="imp-tbl">
            <table className="ui-table">
              <thead><tr><th>id</th><th>Название класса</th>{merge && <th>В проекте</th>}<th>Цвет</th><th>Суперкласс</th><th>Разметок</th></tr></thead>
              <tbody>
                {report.classes.map((c) => (
                  <ClassRow key={c.class_index} cls={c} draft={drafts[c.class_index]} superclasses={supers}
                    maxCount={maxCount} projectClasses={merge ? projectClasses ?? [] : null}
                    onChange={(patch) => setDrafts((prev) => ({ ...prev, [c.class_index]: { ...prev[c.class_index], ...patch } }))} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="row">
            <Input value={newSuperclass} placeholder="Новый суперкласс" style={{ maxWidth: 260 }}
              onChange={(e) => setNewSuperclass(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSuperclass(); } }} />
            <Button icon="plus" disabled={!newSuperclass.trim()} onClick={addSuperclass}>Добавить</Button>
          </div>
        </>
      ),
      footer: <>{cancelBtn}<span className="grow" />{!confirmCancel && (
        <Button variant="primary" disabled={busy || unnamed > 0 || clash.length > 0 || !datasetName.trim()} onClick={handleCommit}>Записать в проект</Button>
      )}</>,
    });
  }

  // --- 4. Запись ---
  if (state.status === "writing") {
    return dialog({
      step: 3,
      body: <Stage ring={<Ring value={jobPct ?? 0} label="Запись в проект" />} title="Записываю в проект"
        sub="Создаю превью и сохраняю разметку" pills={<Pill>Окно можно закрыть — запись идёт на сервере</Pill>} />,
      footer: <><span className="grow" />{fold}</>,
    });
  }

  // --- Готово ---
  if (state.status === "done" && state.result) {
    const r = state.result;
    return dialog({
      step: "done",
      body: <Stage ring={<Ring tone="done" label="Импорт завершён" />} title="Импорт завершён"
        sub={`Датасет «${state.dataset_name || datasetName || "без названия"}»`}
        pills={<>
          <Pill tone="ok">{count(r.images, "изображение записано", "изображения записано", "изображений записано")}</Pill>
          {r.unreadable > 0 && <Pill tone="bad">{count(r.unreadable, "изображение не открылось", "изображения не открылись", "изображений не открылось")}</Pill>}
          {r.orphan_boxes > 0 && <Pill tone="warn">{count(r.orphan_boxes, "разметка без класса", "разметки без класса", "разметок без класса")}</Pill>}
        </>} />,
      footer: <><span className="grow" /><Button variant="ghost" onClick={onClose}>Закрыть</Button>
        <LinkButton variant="primary" to={`/projects/${code}/datasets?ds=${r.dataset_id}`}>Открыть датасет</LinkButton></>,
    });
  }

  // --- Ошибка: живёт на сервере, после перезагрузки окно её показывает ---
  return dialog({
    step: report ? 3 : 1,
    bad: true,
    body: <Stage ring={<Ring tone="bad" label="Импорт не удался" />} title="Импорт не удался"
      pills={<Pill tone="bad">{state.error || "Причина не сохранилась"}</Pill>} />,
    footer: <><span className="grow" /><Button variant="ghost" onClick={onClose}>Закрыть</Button>
      <Button variant="primary" icon="refresh" onClick={handleRestart}>Начать заново</Button></>,
  });
}

function Steps({ step, bad }: { step: number | "done"; bad?: boolean }) {
  const done = step === "done";
  const cur = done ? STEPS.length : step;
  const label = done ? "Импорт завершён" : `Шаг ${cur + 1} из ${STEPS.length} · ${STEPS[cur]}`;
  const next = !done && !bad && cur < STEPS.length - 1 ? `дальше: ${STEPS[cur + 1].toLowerCase()}` : "";
  return (
    <div className="imp-steps" aria-label="Шаги импорта">
      <div className="imp-steps-h"><b className={done ? "ok" : bad ? "bad" : undefined}>{label}</b>{next && <span>{next}</span>}</div>
      <div className="imp-steps-bar">
        {STEPS.map((n, i) => (
          <i key={n} title={n} className={done ? "ok" : bad && i === cur ? "bad" : i < cur ? "on" : i === cur ? "cur" : undefined} />
        ))}
      </div>
    </div>
  );
}

function Stage({ ring, title, sub, pills }: { ring: ReactNode; title: ReactNode; sub?: ReactNode; pills?: ReactNode }) {
  return (
    <div className="imp-stage">
      {ring}
      <div className="imp-stage-t"><b>{title}</b>{sub && <span>{sub}</span>}</div>
      {pills && <div className="ui-pills imp-center">{pills}</div>}
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return <div className="imp-stat"><b>{value}</b><span>{label}</span></div>;
}

function ClassRow({ cls, draft, superclasses, maxCount, projectClasses, onChange }: {
  cls: ScannedClass;
  draft?: ClassDraft;
  superclasses: string[];
  maxCount: number;
  /** null — проект пуст, сверять не с чем. */
  projectClasses: LabelClass[] | null;
  onChange: (patch: Partial<ClassDraft>) => void;
}) {
  const name = draft?.name ?? "";
  const color = draft?.color ?? PALETTE[0];
  const target = draft?.target ? projectClasses?.find((pc) => pc.id === draft.target) : undefined;
  return (
    <tr className={target ? "imp-mapped" : undefined}>
      <td className="imp-id">{cls.class_index}</td>
      <td>
        {target ? (
          <span className="imp-arch" title="Имя в архиве">{cls.yaml_name ?? "без имени в data.yaml"}</span>
        ) : (
          <Input value={name} invalid={!name.trim()} aria-label={`Название класса ${cls.class_index}`}
            className={name.trim() ? undefined : "imp-blank"}
            placeholder={cls.yaml_name === null ? "Нет в data.yaml — найден в разметке" : "Имя не указано в data.yaml"}
            onChange={(e) => onChange({ name: e.target.value })} />
        )}
      </td>
      {projectClasses && (
        <td style={{ width: 168 }}>
          <Select full size="sm" value={draft?.target ?? "new"} label={`Класс проекта для класса ${cls.class_index}`}
            onChange={(v) => onChange({ target: v === "new" ? null : v })}
            options={[{ value: "new", label: "Новый класс" },
              ...projectClasses.map((pc) => ({ value: pc.id, label: pc.name, hint: `№ ${pc.class_index}${pc.superclass_name ? ` · ${pc.superclass_name}` : ""}` }))]} />
        </td>
      )}
      <td style={{ width: 52 }}>
        {target ? (
          <span className="imp-sw static" title="Цвет класса проекта"><i style={{ "--cc": target.color } as CSSProperties} /></span>
        ) : (
          <Popover width={260} trigger={
            <button type="button" className="imp-sw" aria-label={`Цвет класса ${cls.class_index}`}>
              <i style={{ "--cc": color } as CSSProperties} />
            </button>
          }>
            <ColorPicker value={color} onChange={(c) => onChange({ color: c })} />
          </Popover>
        )}
      </td>
      <td style={{ width: 150 }}>
        {target ? (
          <span className="t-muted t-sm">{target.superclass_name ?? "без группы"}</span>
        ) : (
          <Select full size="sm" value={draft?.superclass ?? "none"} label={`Суперкласс класса ${cls.class_index}`}
            onChange={(v) => onChange({ superclass: v === "none" ? null : v })}
            options={[{ value: "none", label: "Без группы" }, ...superclasses.map((sc) => ({ value: sc, label: sc }))]} />
        )}
      </td>
      <td className="imp-cnt">
        <span className="imp-bar"><i style={{ width: `${(cls.annotations / maxCount) * 100}%` }} /></span>
        {cls.annotations ? <span className="ui-mono">{ru(cls.annotations)}</span> : <span className="t-faint t-xs">не встречен</span>}
      </td>
    </tr>
  );
}

/** Адрес /projects/<код>/import: обзор, поверх него — окно импорта. Ссылку можно дать и вернуться к ней. */
export function ImportRoute() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  return (
    <>
      <ProjectOverview />
      <ImportDialog onClose={() => navigate(`/projects/${code}`)} />
    </>
  );
}
