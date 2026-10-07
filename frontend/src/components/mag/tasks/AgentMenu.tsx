// Меню «⋯» блока и ролика на странице таски: агент сразу, без окна, и удаление.
//
// Решения владельца (2026-10-07): пункт запускает разметку или разведку агентом по
// умолчанию («Агент таски», шестерёнка в шапке меню); шаг кадров — полем прямо
// здесь, по умолчанию 25; «Удалить» переехало сюда из корзины.

import { useState } from "react";
import { Button, Icon, MenuItem, Popover } from "../../../ui";
import type { IconName } from "../../../ui";
import { NumInput } from "../../NumInput";
import type { AgentToolState } from "../../editor/AgentTool";

export interface AgentAction {
  label: string;
  icon: IconName;
  /** Нечего делать или нельзя — причина вместо подсказки, пункт погашен. */
  off?: string | false;
  hint?: string;
  run: (step: number) => void;
}

export default function AgentMenu({ tool, actions, step: withStep, busy, onSetup, deleteLabel, onDelete, label }: {
  tool: AgentToolState;
  actions: AgentAction[];
  /** Поле «каждый N-й кадр» — там, где есть ролики. */
  step?: boolean;
  /** Агент уже идёт по таске: на таску один прогон. */
  busy?: boolean;
  onSetup: () => void;
  deleteLabel?: string;
  onDelete?: () => void;
  label: string;
}) {
  const [step, setStep] = useState(25);
  const name = tool.agent ? `${tool.agent.name}` : null;
  return (
    <Popover align="end" width={300} className="am" onOpenChange={(v) => v && setStep(25)}
      trigger={<Button variant="ghost" size="sm" icon="more" aria-label={label} title={label} />}>
      {(close) => (
        <>
          <div className="am-h">
            <Icon name="bot" size={14} />
            <span className="am-who t-ell">
              {name ? <>Агент: <b>{name}</b>{tool.version && <span className="ui-mono"> v{tool.version.version}</span>}</>
                : <span className="t-muted">Агент не выбран</span>}
            </span>
            <Button variant="ghost" size="sm" icon="settings" aria-label="Агент таски и классы" title="Агент таски и классы"
              onClick={() => { close(); onSetup(); }} />
          </div>
          {actions.map((a) => {
            const why = busy ? "агент уже идёт по таске" : !tool.agent ? "выберите агента ⚙" : a.off;
            return (
              <MenuItem key={a.label} icon={a.icon} disabled={!!why} hint={why || a.hint}
                onSelect={() => { close(); a.run(step); }}>{a.label}</MenuItem>
            );
          })}
          {withStep && (
            <label className="am-step" onKeyDown={(e) => e.stopPropagation()}>
              <span>Каждый N-й кадр</span>
              <NumInput className="ui-input ui-ctl ui-mono" value={step} min={1} max={10000} integer
                aria-label="Каждый N-й кадр" onValue={(v) => v !== undefined && setStep(v)} />
            </label>
          )}
          {onDelete && (
            <>
              <div className="ui-pop-sep" />
              <MenuItem icon="trash" danger onSelect={() => { close(); onDelete(); }}>{deleteLabel ?? "Удалить"}</MenuItem>
            </>
          )}
        </>
      )}
    </Popover>
  );
}
