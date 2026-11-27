import { useState } from "react";
import { transferTaskCut } from "../../../auth/api";
import type { TaskDetail } from "../../../auth/api";
import type { Tag } from "../../../api/tags";
import { Button, Check, Dialog, Field, Icon, Notice } from "../../../ui";
import { count } from "../../ru";

export function CutTransfer({ task, tags, onTransfer }: {
  task: TaskDetail; tags: Tag[]; onTransfer: (taskId: string) => void;
}) {
  const videos = task.videos.filter((video) => video.mode === "cut" && video.frames > 0);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState(new Set<string>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const chosen = videos.filter((video) => selected.has(video.id));
  const frames = chosen.reduce((total, video) => total + video.frames, 0);
  const all = videos.length > 0 && chosen.length === videos.length;
  const frameCount = (n: number) => count(n, "кадр", "кадра", "кадров");

  function selectAll(checked: boolean) {
    setSelected(new Set(checked ? videos.map((video) => video.id) : []));
  }

  function start() {
    setName(`${task.name.slice(0, 245)} · нарезка`);
    selectAll(true);
    setError(undefined);
    setOpen(true);
  }

  function toggle(id: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    setSelected(next);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !name.trim() || !frames) return;
    setBusy(true);
    setError(undefined);
    try {
      const { task_id } = await transferTaskCut(task.id, name.trim(), chosen.map((video) => video.id));
      setOpen(false);
      onTransfer(task_id);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <>
    {videos.length > 0 && <Button className="tp-transfer-button" size="sm" variant="outline" icon="split" onClick={start}>
      Перенести в новую таску
    </Button>}
    <Dialog open={open} onOpenChange={setOpen} title="Перенести нарезку в новую таску"
      desc="Выбранные ролики и их кадры перейдут из этой таски в новую." width={610} modalLock closable={!busy}
      footer={<><Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Отмена</Button>
        <Button variant="primary" icon="forward" disabled={busy || !name.trim() || !frames} type="submit" form="cut-transfer-form">
          {busy ? "Переношу…" : "Создать таску и перенести"}
        </Button></>}>
      <form className="transfer-form" id="cut-transfer-form" onSubmit={submit}>
        {error && <Notice tone="error">{error}</Notice>}
        <Field label="Название новой таски">{(id) => <input id={id} className="ui-input" value={name} required maxLength={255}
          disabled={busy} onChange={(event) => setName(event.target.value)} />}</Field>
        <section className="transfer-videos" aria-label="Ролики для переноса">
          <div className="transfer-videos-head">
            <Check checked={all} disabled={busy} indeterminate={chosen.length > 0 && !all} onChange={selectAll}>Выбрать все ролики</Check>
            <span className="t-xs t-muted">{chosen.length} из {videos.length}</span>
          </div>
          <div className="transfer-videos-list">
            {videos.map((video) => <div className="transfer-video" key={video.id}>
              <Check checked={selected.has(video.id)} disabled={busy} onChange={(checked) => toggle(video.id, checked)}>
                <span className="transfer-video-name" title={video.file_name}>{video.file_name}</span>
              </Check>
              <span className="transfer-video-count t-sm">{frameCount(video.frames)}</span>
              <div className="transfer-video-tags t-xs t-muted"><Icon name="tag" size={12} />
                {video.tag_ids.map((id) => tags.find((tag) => tag.id === id)?.name).filter(Boolean).join(", ") || "Без тагов"}
              </div>
            </div>)}
          </div>
        </section>
        <div className="transfer-summary" aria-live="polite">
          <div><Icon name="database" /><span className="t-sm">Датасет <strong>{task.target_dataset?.name || task.name}</strong></span></div>
          <strong className="t-sm">{count(chosen.length, "ролик", "ролика", "роликов")}, {frameCount(frames)}</strong>
          <span className="t-xs t-muted">Новая таска появится в «На очереди». Имена кадров и таги сохранятся.</span>
        </div>
      </form>
    </Dialog>
  </>;
}
