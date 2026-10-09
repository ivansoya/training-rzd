// Влезет ли агент на карту — плашка вердикта и окно «Ресурсы» (решения 09.10.2026).
//
// Число считает сервер (`POST /api/agents/estimate`, common/agent_memory.py) — той же
// функцией, что запуск и сам прогон: плашка в редакторе и решение диспетчера не расходятся.

import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes } from "react";
import * as api from "../../api/agents";
import { Icon, cx, type IconName } from "../../ui";
import { count } from "../ru";

export const gb = (mb: number) => (mb / 1024).toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const VERDICT: Record<api.VerdictState, { icon: IconName; word: string; tone: string }> = {
  fits: { icon: "ok", word: "влезает", tone: "ok" },
  wait: { icon: "clock", word: "придётся ждать", tone: "wait" },
  sequential: { icon: "layers", word: "только поочерёдно", tone: "seq" },
  never: { icon: "ban", word: "не запустится", tone: "no" },
};

/** Подробность вердикта одной строкой: где влезает, сколько свободно, что мешает. */
export function verdictDetail(est: Pick<api.Estimate, "verdict" | "cards" | "queued" | "heaviest" | "total_mb">): string {
  const cap = Math.max(0, ...est.cards.map((c) => c.cap_mb));
  const free = Math.max(0, ...est.cards.map((c) => c.free_mb));
  const v = est.verdict;
  if (!est.cards.length) return "на сервере нет видеокарт";
  if (v.state === "fits") {
    const card = est.cards.find((c) => c.name === v.card) ?? est.cards[0];
    return `${short(card.name)}, свободно ${gb(card.free_mb)} из ${gb(card.cap_mb)}`;
  }
  if (v.state === "wait") {
    return `свободно ${gb(free)} из ${gb(cap)}${est.queued ? `, впереди ${count(est.queued, "работа", "работы", "работ")}` : ""}`;
  }
  if (v.state === "sequential") return `самый тяжёлый узел ${gb(est.heaviest?.mb ?? 0)} из ${gb(cap)}, медленнее`;
  return `${est.heaviest?.label ?? "узел"} один ${gb(est.heaviest?.mb ?? est.total_mb)} — больше ${gb(cap)}`;
}

/** «NVIDIA GeForce RTX 5070 Ti» → «RTX 5070 Ti»: в плашке место дорого. */
export const short = (name: string) => name.replace(/^NVIDIA\s+/i, "").replace(/^GeForce\s+/i, "");

/** Плашка вердикта: значок, «≈ 7,2 ГБ», слово и подробность. С `button` — кнопка
 *  (триггер окна «Ресурсы»: ref и свойства Popover уходят на неё). */
export const VerdictChip = forwardRef<HTMLButtonElement, {
  est: api.Estimate | null;
  busy?: boolean;
  button?: boolean;
  /** Без подробности — для списков; «word» — только слово вердикта (шапка редактора, где тесно). */
  compact?: boolean | "word";
  /** «замер, 3 запуска» вместо подробности — в окне запуска. */
  source?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>>(function VerdictChip({ est, busy, button, compact, source, className, ...rest }, ref) {
  if (!est) {
    return (
      <span className="ae-vd idle"><Icon name="cpu" size={15} /><span>{busy ? "считаю память…" : "память — после правки"}</span></span>
    );
  }
  const look = VERDICT[est.verdict.state];
  const tail = source ? (est.measured ? `замер, ${count(est.measured, "запуск", "запуска", "запусков")}` : "прикидка")
    : verdictDetail(est);
  const body = (
    <>
      <Icon name={look.icon} size={15} />
      <b>≈ {gb(est.total_mb)}</b><span>ГБ</span>
      {compact === "word" && <><span>·</span><em>{look.word}</em></>}
      {!compact && <><span>·</span><span className="t-ell"><em>{look.word}{source ? "" : ":"}</em>{source ? " — " : " "}{tail}</span></>}
    </>
  );
  return button ? (
    <button ref={ref} type="button" className={cx("ae-vd", look.tone, busy && "busy", className)}
      title={est.verdict.reason} aria-label={`Ресурсы: ${est.verdict.reason}`} {...rest}>{body}</button>
  ) : (
    <span className={cx("ae-vd", look.tone, className)} title={est.verdict.reason}>{body}</span>
  );
});

/** Окно «Ресурсы»: карты и память по узлам; самый тяжёлый узел — цветом числа. */
export function ResourcesPanel({ est }: { est: api.Estimate }) {
  const sum = est.units.map((u) => gb(u.mb)).join(" + ");
  return (
    <div className="ae-res">
      <div className="ae-res-h">
        <b>Ресурсы</b>
        <span className="t-xs t-muted">≈ {gb(est.total_mb)} ГБ · {est.measured ? `замер, ${count(est.measured, "запуск", "запуска", "запусков")}` : "прикидка"}</span>
      </div>

      <section>
        <div className="ae-res-l"><span>Карты</span><em>считает сервер, без имён держателей</em></div>
        {est.cards.length === 0 && <p className="t-xs t-muted">На сервере нет видеокарт — агенты не запустятся.</p>}
        {est.cards.map((c) => {
          const used = c.cap_mb - c.free_mb;
          return (
            <div key={c.id} className="ae-res-card">
              <div className="ae-res-r"><b>{short(c.name)}</b><span className="t-xs t-muted">под задачи {gb(c.cap_mb)} ГБ</span></div>
              <div className="ae-res-bar" aria-hidden="true">
                <i style={{ width: `${(used / Math.max(1, c.cap_mb)) * 100}%` }} />
                <s style={{ left: `${Math.min(100, (used / Math.max(1, c.cap_mb)) * 100)}%`,
                  width: `${Math.min(100 - (used / Math.max(1, c.cap_mb)) * 100, (est.verdict.want_mb / Math.max(1, c.cap_mb)) * 100)}%` }} />
              </div>
              <div className="t-xs t-muted">
                свободно {gb(c.free_mb)} из {gb(c.cap_mb)} · агенту нужно {gb(est.verdict.want_mb)}
                {est.queued ? ` · в очереди ${count(est.queued, "работа", "работы", "работ")}` : ""}
              </div>
            </div>
          );
        })}
      </section>

      <section>
        <div className="ae-res-l"><span>По узлам</span></div>
        {est.units.map((u) => {
          const heavy = est.heaviest?.key === u.key && est.units.length > 1;
          return (
            <div key={u.key} className="ae-res-u">
              <span className="t-ell">{u.label}{u.nodes.length > 1 ? ` · ${u.nodes.length} узла, одна модель` : ""}</span>
              <b className={heavy ? "heavy" : undefined} title={heavy ? "Самый тяжёлый узел агента" : undefined}>{gb(u.mb)} ГБ</b>
            </div>
          );
        })}
        <div className="ae-res-u sum">
          <span>Сумма{est.units.length > 1 && <em>{sum}</em>}</span>
          <b>{gb(est.estimate_mb)} ГБ</b>
        </div>
      </section>
    </div>
  );
}

/** Оценка черновика: пересчёт через 250 мс после правки, устаревший ответ отбрасывается по номеру. */
export function useEstimate(graphId: string | undefined, doc: unknown, enabled = true) {
  const [est, setEst] = useState<api.Estimate | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const key = JSON.stringify(doc);
  useEffect(() => {
    if (!enabled || !doc) return;
    const n = ++seq.current;
    const ctl = new AbortController();
    setBusy(true);
    const timer = window.setTimeout(() => {
      api.estimateAgent({ graph_id: graphId, doc }, ctl.signal)
        .then((got) => { if (n === seq.current) setEst(got); })
        .catch(() => undefined)
        .finally(() => { if (n === seq.current) setBusy(false); });
    }, 250);
    return () => { window.clearTimeout(timer); ctl.abort(); };
    // Документ сравнивается по содержимому: новый объект на каждый рендер — не правка.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphId, key, enabled]);
  return { est, busy };
}
