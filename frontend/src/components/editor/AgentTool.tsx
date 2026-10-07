// Кнопка «Агент» (G) в панели инструментов редакторов: агент на текущем кадре.
//
// Решение владельца (2026-10-07): сразу в режиме разметки, рамки встают на
// проверку тем же порядком, что после агента на блоке. Какого агента звать —
// во всплывашке у кнопки; выбор помнится на таску.

import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../../api/agents";
import { Button, Field, Select } from "../../ui";
import { count } from "../ru";
import { ToolButton, ToolMenu } from "./Chrome";

const keyOf = (taskId: string) => `mag.agent.tool.${taskId}`;

function storedPick(taskId: string): { agent: string; version: string } | null {
  try { return JSON.parse(window.localStorage.getItem(keyOf(taskId)) || "null"); } catch { return null; }
}

/** Агент для кнопки: что выбрано, сколько классов сопоставлено, и сам вызов. */
export function useAgentTool(taskId: string) {
  const [ctx, setCtx] = useState<api.RunContext | null>(null);
  const [pick, setPick] = useState(() => storedPick(taskId));
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    api.runContext(taskId).then((c) => alive && setCtx(c)).catch(() => alive && setCtx(null));
    return () => { alive = false; };
  }, [taskId, tick]);

  const agent = ctx?.agents.find((a) => a.id === pick?.agent) ?? ctx?.agents[0] ?? null;
  const version = agent?.versions.find((v) => v.id === pick?.version)
    ?? agent?.versions.find((v) => v.id === agent.head) ?? agent?.versions[0] ?? null;
  // Сопоставленным считается то, что сервер возьмёт сам: ссылка на класс проекта или запомненное
  const mapped = useMemo(() => {
    if (!ctx || !agent || !version) return 0;
    const saved = ctx.mappings[agent.id];
    return version.classes.filter((c) => c.lock || saved?.[c.id] || saved?.[c.name]).length;
  }, [ctx, agent, version]);

  const choose = useCallback((agentId: string, versionId?: string) => {
    const a = ctx?.agents.find((x) => x.id === agentId);
    const next = { agent: agentId, version: versionId ?? a?.head ?? "" };
    setPick(next);
    try { window.localStorage.setItem(keyOf(taskId), JSON.stringify(next)); } catch { /* не запомнится */ }
  }, [ctx, taskId]);

  const apply = useCallback(async (target: { image_id: string } | { video_id: string; frame_no: number }) => {
    if (!agent || !version) throw new Error("Агентов с сохранённой версией нет.");
    setBusy(true);
    try {
      return await api.applyAgent(taskId, { graph_id: agent.id, version_id: version.id, ...target });
    } finally {
      setBusy(false);
    }
  }, [taskId, agent, version]);

  /** Прогон по блоку из меню: сопоставление — запомненное, окна нет. */
  const start = useCallback(async (body: { mode: api.RunMode; sources?: string[]; videos?: string[]; step: number }) => {
    if (!ctx || !agent || !version) throw new Error("Агентов с сохранённой версией нет.");
    const saved = ctx.mappings[agent.id];
    const mapping: Record<string, string | null> = {};
    for (const c of version.classes) mapping[c.id] = c.lock ?? saved?.[c.id] ?? saved?.[c.name] ?? null;
    return api.startRun(taskId, {
      graph_id: agent.id, version_id: version.id, mode: body.mode, sources: body.sources ?? [],
      videos: body.videos ?? [], step: body.step, gap: 2, mapping,
    });
  }, [ctx, agent, version, taskId]);

  const reason = !ctx ? "Загружаю агентов…"
    : !ctx.can_run ? "Звать агента можно в своей таске"
    : !agent || !version ? "Агентов с сохранённой версией нет"
    : mapped === 0 ? "Классы агента не сопоставлены с проектом — откройте ▾" : null;

  return { ctx, agent, version, mapped, busy, ready: !reason, reason, choose, apply, start,
    reload: () => setTick((t) => t + 1) };
}

export type AgentToolState = ReturnType<typeof useAgentTool>;

/** Кнопка и всплывашка выбора. `onMap` — окно запуска, где сопоставляют классы. */
export function AgentTool({ tool, disabled, onRun, onMap }: {
  tool: AgentToolState;
  disabled?: boolean;
  onRun: () => void;
  onMap: () => void;
}) {
  const { ctx, agent, version, mapped, busy, reason } = tool;
  return (
    <>
      <ToolButton icon="bot" label="Агент на этом кадре" k="G" pressed={false} warming={busy}
        disabled={disabled || busy || !tool.ready}
        title={busy ? "Агент смотрит кадр…" : reason ?? `Агент «${agent?.name}» на этом кадре — рамки встанут на проверку (G)`}
        onClick={onRun} />
      <ToolMenu label="Какого агента звать" width={300}>
        <div className="ed-set-b">
          <div className="ui-pop-h">Агент на кадре</div>
          {!ctx && <p className="ed-set-hint">Загружаю…</p>}
          {ctx && !ctx.agents.length && <p className="ed-set-hint">Агентов с сохранённой версией нет — соберите агента и сохраните версию.</p>}
          {ctx && agent && version && (
            <>
              <Field label="Агент">
                {(id) => <Select id={id} full size="sm" value={agent.id} onChange={(v) => tool.choose(v)}
                  options={ctx.agents.map((a) => ({ value: a.id, label: a.name }))} />}
              </Field>
              <Field label="Версия">
                {(id) => <Select id={id} full size="sm" value={version.id} onChange={(v) => tool.choose(agent.id, v)}
                  options={agent.versions.map((v) => ({ value: v.id, label: `Версия ${v.version}` }))} />}
              </Field>
              <div className="ed-set-row ed-agent-map">
                <span>Классы</span>
                <span className={mapped ? "t-muted" : "ed-agent-warn"}>
                  {mapped} из {count(version.classes.length, "класса", "классов", "классов")} сопоставлено
                </span>
              </div>
              <Button variant="ghost" size="sm" icon="settings" onClick={onMap}>Агент таски и классы…</Button>
              <p className="ed-set-hint">Рамки агента встанут на проверку; прежнее непроверенное на кадре заменится.</p>
            </>
          )}
        </div>
      </ToolMenu>
    </>
  );
}
