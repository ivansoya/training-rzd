// Полоса «В таску» внизу галереи (решения 14–15.10.2026): кадры датасета уходят в таску копиями —
// только выбранные и только в режиме отбора. Новая таска — окном, открытая — сразу, итогом со ссылкой.

import { useCallback, useEffect, useState } from "react";
import { listTasks } from "../../../auth/api";
import type { TaskLight } from "../../../auth/api";
import { takeIntoTask } from "../../../api/gallery";
import { Button, Icon, LinkButton, MenuItem, Popover } from "../../../ui";
import { count, plural, ru } from "../../ru";

export function TakeBar({ code, title, ids, unseen, onClear, onNew, onError }: {
  code: string;
  /** Датасет в режиме отбора; null — режима нет, видна только плашка итога. */
  title: string | null;
  /** Выбранные кадры — они и уйдут. */
  ids: string[];
  /** Выбраны, но не видны под нынешним отбором — уйдут тоже. */
  unseen: number;
  /** Снять выбор и выйти из отбора. */
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
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(null), 8000);
    return () => window.clearTimeout(t);
  }, [done]);

  const into = async (t: TaskLight) => {
    setBusy(true);
    try {
      const got = await takeIntoTask(t.id, ids);
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

  const n = ids.length;
  return (
    <div className="fr-take" role="region" aria-label="Кадры в таску">
      {done && (
        <div className="fr-take-done" role="status">
          <Icon name="tick" size={14} />
          <span>{done.text}</span>
          <LinkButton size="sm" to={`/projects/${code}/tasks/${done.taskId}`}>Открыть таску</LinkButton>
        </div>
      )}
      {title !== null && (
        <div className="fr-take-bar">
          <Button variant="ghost" size="sm" icon="x" aria-label="Снять выбор и выйти из отбора" onClick={onClear} />
          <span className="fr-take-ds t-ell">Отбор · {title}</span>
          <span>выбрано <b className="ui-mono">{ru(n)}</b></span>
          {unseen > 0 && <span className="t-xs t-muted">из них не видно {ru(unseen)}</span>}
          <i className="fr-take-sep" />
          <Popover side="top" align="end" width={330} onOpenChange={(v) => v && load()}
            trigger={<Button variant="primary" size="sm" icon="check" iconEnd="chevD" disabled={busy || !n}>В таску</Button>}>
            {(close) => (
              <>
                <div className="ui-pop-h"><span>{count(n, "кадр уйдёт", "кадра уйдут", "кадров уйдут")} копиями</span></div>
                <MenuItem icon="plus" onSelect={() => { close(); onNew(ids); }}>Новая таска…</MenuItem>
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
      )}
    </div>
  );
}
