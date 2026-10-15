// Полоса «В таску» внизу галереи (решения 14.10.2026): кадры датасета уходят в таску копиями —
// выбранные, а без выбора весь отбор. Новая таска — окном, открытая — сразу, итогом со ссылкой.

import { useCallback, useEffect, useState } from "react";
import { listTasks } from "../../../auth/api";
import type { TaskLight } from "../../../auth/api";
import { takeIntoTask } from "../../../api/gallery";
import { Button, Icon, LinkButton, MenuItem, Popover } from "../../../ui";
import { count, plural, ru } from "../../ru";

export function TakeBar({ code, selected, unseen, matched, ids, onClear, onNew, onError }: {
  code: string;
  /** Выбрано плиток; 0 — уйдёт весь отбор. */
  selected: number;
  /** Выбраны, но не видны под нынешним отбором — уйдут тоже. */
  unseen: number;
  matched: number;
  /** id кадров, которые уйдут: выбранные или весь отбор. */
  ids: () => Promise<string[]>;
  onClear: () => void;
  onNew: (ids: string[]) => void;
  onError: (message: string) => void;
}) {
  const [tasks, setTasks] = useState<TaskLight[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ text: string; taskId: string } | null>(null);

  const load = useCallback(() => {
    listTasks(code).then((r) => setTasks(r.tasks.filter((t) => t.fill))).catch(() => setTasks([]));
  }, [code]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(null), 8000);
    return () => window.clearTimeout(t);
  }, [done]);

  const into = async (t: TaskLight) => {
    setBusy(true);
    try {
      const got = await takeIntoTask(t.id, await ids());
      const skipped = got.busy.reduce((a, b) => a + b.n, 0);
      onClear();
      setDone({
        taskId: t.id,
        text: `В «${t.name}» ${plural(got.added, "ушёл", "ушли", "ушли")} ${count(got.added, "кадр", "кадра", "кадров")}`
          + (skipped ? ` · пропущено ${ru(skipped)} — уже в тасках` : ""),
      });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const startNew = async () => {
    setBusy(true);
    try {
      onNew(await ids());
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const n = selected || matched;
  return (
    <div className="fr-take" role="region" aria-label="Кадры в таску">
      {done && (
        <div className="fr-take-done" role="status">
          <Icon name="tick" size={14} />
          <span>{done.text}</span>
          <LinkButton size="sm" to={`/projects/${code}/tasks/${done.taskId}`}>Открыть таску</LinkButton>
        </div>
      )}
      <div className="fr-take-bar">
        {selected ? (
          <>
            <span>Выбрано <b className="ui-mono">{ru(selected)}</b></span>
            {unseen > 0 && <span className="t-xs t-muted">из них не видно {ru(unseen)}</span>}
            <Button variant="ghost" size="sm" onClick={onClear}>Снять</Button>
          </>
        ) : (
          <span>Отбор · <b className="ui-mono">{ru(matched)}</b> {plural(matched, "кадр", "кадра", "кадров")}</span>
        )}
        <i className="fr-take-sep" />
        <Popover side="top" align="end" width={330} onOpenChange={(v) => v && load()}
          trigger={<Button variant="primary" size="sm" icon="check" iconEnd="chevD" disabled={busy}>В таску</Button>}>
          {(close) => (
            <>
              <div className="ui-pop-h"><span>{count(n, "кадр уйдёт", "кадра уйдут", "кадров уйдут")} копиями</span></div>
              <MenuItem icon="plus" onSelect={() => { close(); void startNew(); }}>Новая таска…</MenuItem>
              <div className="ui-pop-h"><span>Пополнить открытую</span></div>
              {tasks === null ? <p className="search-none">Загружаю…</p>
                : tasks.length === 0 ? <p className="search-none">Пополнять нечего: нет открытых тасок, где вы работаете.</p>
                  : tasks.map((t) => (
                    <MenuItem key={t.id} icon="check" hint={t.status_label}
                      onSelect={() => { close(); void into(t); }}>{t.name}</MenuItem>
                  ))}
            </>
          )}
        </Popover>
      </div>
    </div>
  );
}
