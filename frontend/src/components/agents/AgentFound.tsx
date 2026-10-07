// Шторка, под превью: сверка выхода узла, на который смотрит превью, с ручной разметкой кадра.
// Честная: сверяются только классы, которые узел может выдать (verdict.ts). Ручная разметка
// прочих классов не считается пропуском — она перечислена отдельно как «не ищет».

import type { CSSProperties } from "react";
import { Swatch, cx } from "../../ui";
import { count, ru } from "../ru";
import type { AgentKind } from "./look";
import { MATCH_IOU, type Verdict } from "./verdict";

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)} %` : "—");
const STATUS: Record<string, string> = { new: "новый — до него не дошли руки", skipped: "отложен", deleted: "в браке" };

export default function AgentFound({ kind, title, verdict, colorOf, unchecked }: {
  kind: AgentKind | null;
  /** Подпись узла, на который смотрит превью: он не всегда выделенный. */
  title: string | null;
  verdict: Verdict | null;
  colorOf: (cls: string) => string;
  /** Состояние кадра, если его разметка не проверена: тогда сверки нет. */
  unchecked: string | null;
}) {
  const v = verdict;
  const hit = v?.hit.length ?? 0, wrong = v?.wrong.length ?? 0, missed = v?.missed.length ?? 0;
  const top = Math.max(1, ...(v?.byClass ?? []).map((r) => r.hit + r.wrong + r.missed));

  let body;
  if (unchecked) {
    body = (
      <div className="ae-vd-off">
        <b>Кадр не проверен — сверять не с чем</b>
        <span>
          Кадр {STATUS[unchecked] ?? unchecked}: его разметку человек не подтвердил, и находки узла здесь не отличить
          от ошибок. Сверка считается на кадрах из данных проекта и на кадрах тасок «размечен» или «пусто» — листайте к ним.
        </span>
      </div>
    );
  } else if (!v) body = <p className="ae-f-none">Появится, когда превью посчитает кадр.</p>;
  else if (kind === "frame") body = <p className="ae-f-none">«Кадр» ничего не ищет — сверять нечего.</p>;
  else {
    body = (
      <>
        <div className="ae-vd">
          <div className="ae-vd-c ok"><b className="ui-mono">{ru(hit)}</b><small><i />верно</small></div>
          <div className="ae-vd-c bad"><b className="ui-mono">{ru(wrong)}</b><small><i />ложных</small></div>
          <div className="ae-vd-c miss"><b className="ui-mono">{ru(missed)}</b><small><i />не нашёл</small></div>
        </div>
        <p className="ae-vd-sum">
          Точность <b className="ui-mono">{pct(hit, hit + wrong)}</b> · полнота <b className="ui-mono">{pct(hit, hit + missed)}</b>
          <span> · совпадение рамок от IoU {String(MATCH_IOU).replace(".", ",")}</span>
        </p>
        {v.byClass.length > 0 ? (
          <div className="ae-f-cls">
            <div className="ae-f-h"><h5>По классам</h5><span className="ae-f-key">верно · ложных · не нашёл</span></div>
            {v.byClass.map((r) => {
              const all = r.hit + r.wrong + r.missed;
              return (
                <div key={r.cls} className="ae-vbar" title={r.cls} style={{ "--cc": colorOf(r.cls) } as CSSProperties}>
                  <Swatch color={colorOf(r.cls)} />
                  <span className="t-ell">{r.cls}</span>
                  <span className="ae-vbar-t" style={{ width: `${(all / top) * 100}%` }}>
                    {r.hit > 0 && <i className="ok" style={{ flexGrow: r.hit }} />}
                    {r.wrong > 0 && <i className="bad" style={{ flexGrow: r.wrong }} />}
                    {r.missed > 0 && <i className="miss" style={{ flexGrow: r.missed }} />}
                  </span>
                  <span className="ui-mono ae-vbar-n">
                    <b className={cx(!r.hit && "z")}>{r.hit}</b><b className={cx(!r.wrong && "z")}>{r.wrong}</b><b className={cx(!r.missed && "z")}>{r.missed}</b>
                  </span>
                </div>
              );
            })}
          </div>
        ) : <p className="ae-f-none">На этом кадре нет ни находок, ни ручной разметки классов, которые ищет узел.</p>}
        {v.skipped.length > 0 && (
          <p className="ae-vd-skip">
            Не сверяется — узел эти классы не ищет, их разметка на кадре скрыта:{" "}
            {v.skipped.map((s) => `${s.cls} · ${count(s.count, "рамка", "рамки", "рамок")}`).join(", ")}
          </p>
        )}
      </>
    );
  }

  return (
    <section className="ge-sec ae-found">
      <div className="ae-f-title">
        <b>Сверка с разметкой</b>
        {title && <span className="t-ell" title={title}>{title} · на этом кадре</span>}
      </div>
      {body}
    </section>
  );
}
