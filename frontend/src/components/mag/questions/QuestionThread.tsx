// Обсуждение вопроса в правой панели редактора (решение 29.10.2026, макет «Вопросы в разметке»).
// Свёрнутое — заголовок и первая строка, развёрнутое — сообщения, ответ, «Решено».
import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Question, QuestionMessage } from "../../../api/questions";
import { Avatar, Button, Icon, cx } from "../../../ui";
import Sep from "../../Sep";
import { ago, count } from "../../ru";
import { clock } from "./questions";
import type { QuestionsApi } from "./useQuestions";

const LIMIT = 2000;

/** Ctrl+Enter отправляет; Esc снимает поле, а не закрывает редактор. */
function keys(send: () => void, cancel?: () => void) {
  return (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    if (e.key === "Escape" && cancel) { e.preventDefault(); cancel(); }
  };
}

export function QuestionThread({ q, qs, expanded, onExpand, video }: {
  q: Question;
  qs: QuestionsApi;
  expanded: boolean;
  onExpand?: () => void;
  /** В ролике — время кадра в заголовке. */
  video?: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const open = q.status === "open";
  // Развернули — значит прочли: из колокольчика уходит
  useEffect(() => { if (expanded) qs.read(q.id); }, [expanded, q.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    await qs.reply(q.id, text);
    setBusy(false);
    setText("");
  };
  const replies = q.messages.length - 1;
  const head = (
    <div className="qt-h">
      {q.class ? (
        <span className="qt-cls"><i style={{ background: q.class.color ?? "var(--faint)" }} />{q.class.name}</span>
      ) : <span className="qt-cls quiet">{q.object_id ? "объект" : "кадр целиком"}</span>}
      {q.object_gone && <span className="t-xs t-faint">объект удалён</span>}
      {video && q.time_ms != null && <span className="qt-at ui-mono t-xs t-muted">{clock(q.time_ms)}</span>}
    </div>
  );

  if (!expanded) {
    // Блок, а не кнопка: внутри кнопки нельзя другую; раскрывает щелчок по тексту
    return (
      <div className={cx("qt qt-mini", open && "open")}>
        {head}
        <button type="button" className="qt-open" onClick={onExpand}>
          <span className="qt-line t-ell">{q.messages[0]?.text}</span>
          <span className="t-xs t-faint t-ell">{q.author}<Sep />{replies ? count(replies, "ответ", "ответа", "ответов") : "нет ответов"}
            {!open && <><Sep />решено</>}</span>
        </button>
      </div>
    );
  }
  return (
    <div className={cx("qt", open && "open")}>
      {head}
      {q.messages.map((m, i) => <Message key={m.id} m={m} first={i === 0} q={q} qs={qs} />)}
      {!open && q.resolved_by && <span className="t-xs t-faint">Решено<Sep />{q.resolved_by}<Sep />{q.resolved_at ? ago(q.resolved_at) : ""}</span>}
      {/* Действия — своей строкой под сообщениями: в шапке узкой панели они сжимали класс до «челов» */}
      {q.can_settle && (
        <div className="qt-act">
          {open
            ? <Button size="sm" icon="tick" onClick={() => void qs.resolve(q.id)}>Решено</Button>
            : <Button size="sm" variant="ghost" onClick={() => void qs.reopen(q.id)}>Открыть снова</Button>}
          <Button size="sm" variant="ghost" icon="trash" aria-label="Удалить обсуждение" title="Удалить обсуждение"
            onClick={() => void qs.drop(q.id)} />
        </div>
      )}
      {qs.canAsk && (
        <div className="qt-reply">
          <textarea aria-label="Ответ" placeholder="Ответить" value={text} maxLength={LIMIT}
            onChange={(e) => setText(e.target.value)} onKeyDown={keys(() => void send())} />
          <Button size="sm" variant="primary" disabled={!text.trim() || busy} onClick={() => void send()}>Ответить</Button>
        </div>
      )}
    </div>
  );
}

function Message({ m, first, q, qs }: { m: QuestionMessage; first: boolean; q: Question; qs: QuestionsApi }) {
  const [edit, setEdit] = useState<string | null>(null);
  const save = async () => {
    if (edit === null || !edit.trim()) return;
    await qs.edit(q.id, m.id, edit);
    setEdit(null);
  };
  return (
    <div className="qt-m">
      <Avatar name={m.author ?? "?"} size={24} />
      <div className="qt-m-b">
        <div className="qt-m-h">
          <b>{m.author ?? "удалённый участник"}</b>
          <span>{ago(m.at)}{m.edited && <><Sep />изменено</>}</span>
          {m.can_edit && edit === null && (
            <span className="qt-m-act">
              <button type="button" onClick={() => setEdit(m.text)}>Править</button>
              {!first && <button type="button" onClick={() => void qs.remove(q.id, m.id)}>Удалить</button>}
            </span>
          )}
        </div>
        {edit === null ? <p>{m.text}</p> : (
          <div className="qt-reply">
            <textarea aria-label="Правка" value={edit} maxLength={LIMIT} autoFocus
              onChange={(e) => setEdit(e.target.value)} onKeyDown={keys(() => void save(), () => setEdit(null))} />
            <span className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
              <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Отмена</Button>
              <Button size="sm" variant="primary" disabled={!edit.trim()} onClick={() => void save()}>Сохранить</Button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Новый вопрос: к объекту (подпись — его класс) или к кадру целиком. */
export function QuestionCompose({ label, color, onAsk, onCancel }: {
  label: string;
  color?: string | null;
  onAsk: (text: string) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    await onAsk(text);
    setBusy(false);
  };
  return (
    <div className="qt open">
      <div className="qt-h">
        <span className={cx("qt-cls", !color && "quiet")}>{color && <i style={{ background: color }} />}{label}</span>
        <span className="grow" />
        <Icon name="question" size={14} />
      </div>
      <div className="qt-reply">
        <textarea aria-label="Вопрос" placeholder="Что здесь непонятно?" value={text} maxLength={LIMIT} autoFocus
          onChange={(e) => setText(e.target.value)} onKeyDown={keys(() => void send(), onCancel)} />
        <span className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
          <Button size="sm" variant="ghost" onClick={onCancel}>Отмена</Button>
          <Button size="sm" variant="primary" disabled={!text.trim() || busy} onClick={() => void send()}>Задать вопрос</Button>
        </span>
      </div>
    </div>
  );
}
