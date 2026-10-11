// «Агент таски»: агент по умолчанию и сопоставление его классов с классами проекта.
//
// Решение владельца (2026-10-07): меню блоков и кнопка G запускают агента сразу,
// без окна, — поэтому кого звать и куда класть его классы задаётся здесь заранее.
// Выбор агента помнится у человека на таску (агенты личные), сопоставление — на
// сервере, на пару «агент + проект».

import { useEffect, useState } from "react";
import * as api from "../../api/agents";
import { Button, Dialog, Empty, Field, LinkButton, Notice, Select } from "../../ui";
import { count } from "../ru";
import type { AgentToolState } from "../editor/AgentTool";
import ClassMap, { guess, useAutoMapped } from "./ClassMap";
import { verdictLook } from "./GpuVerdict";

export default function AgentSetupDialog({ taskId, tool, onClose, onRunAll }: {
  taskId: string;
  tool: AgentToolState;
  onClose: () => void;
  /** Полное окно запуска — «по всей таске сразу». */
  onRunAll?: () => void;
}) {
  const ctx = tool.ctx;
  const [agentId, setAgentId] = useState(tool.agent?.id ?? "");
  const [versionId, setVersionId] = useState(tool.version?.id ?? "");
  const agent = ctx?.agents.find((a) => a.id === agentId) ?? null;
  const version = agent?.versions.find((v) => v.id === versionId) ?? agent?.versions[0] ?? null;
  const list = version?.classes ?? [];
  const saved = agent ? ctx?.mappings[agent.id] : undefined;
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const auto = useAutoMapped(list, saved, mapping);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Контекст пришёл позже окна — встаём на агента по умолчанию
  useEffect(() => {
    if (!agentId && tool.agent) { setAgentId(tool.agent.id); setVersionId(tool.version?.id ?? tool.agent.head); }
  }, [agentId, tool.agent, tool.version]);
  useEffect(() => {
    if (ctx && version) setMapping(guess(version.classes, ctx.classes, saved));
  }, [ctx, version, saved]);

  const mapped = list.filter((c) => mapping[c.id]).length;
  const save = async () => {
    if (!agent || !version) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveMapping(taskId, { graph_id: agent.id, mapping });
      tool.choose(agent.id, version.id);
      tool.reload();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} width={640} title="Агент таски"
      desc="Его зовут меню блоков и кнопка G в редакторах — сразу, без вопросов. Рамки агента встают на проверку"
      footer={<>
        {onRunAll && <Button variant="agent" icon="sparkle" onClick={onRunAll}>Разметить агентом…</Button>}
        <span className="grow" />
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" disabled={busy || !agent || !version} onClick={() => void save()}>Сохранить</Button>
      </>}>
      <div className="ar">
        {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
        {!ctx && <p className="t-sm t-muted">Загружаю…</p>}
        {ctx && ctx.agents.length === 0 && (
          <Empty icon="sparkle" title="Агентов с сохранённой версией нет" action={<LinkButton to="/agents" icon="forward">К моим агентам</LinkButton>}>
            Соберите агента и сохраните версию — запускается всегда версия.
          </Empty>
        )}
        {ctx && agent && version && (
          <>
            <div className="ar-2">
              <Field label="Агент">
                {(id) => <Select id={id} full label="Агент" value={agent.id} onChange={(v) => {
                  setAgentId(v);
                  setVersionId(ctx.agents.find((a) => a.id === v)?.head ?? "");
                }} options={ctx.agents.map((a) => ({ value: a.id, label: a.name,
                  hint: `${a.group === "project" ? "подключён к проекту" : "мой"} · ${verdictLook(a.verdict).word}` }))} />}
              </Field>
              <Field label="Версия">
                {(id) => <Select id={id} full label="Версия" value={version.id} onChange={setVersionId}
                  options={agent.versions.map((v) => ({
                    value: v.id, label: `Версия ${v.version}`,
                    hint: `${new Date(v.created_at).toLocaleDateString("ru-RU")} · ${count(v.classes.length, "класс", "класса", "классов")}`,
                  }))} />}
              </Field>
            </div>
            {list.length > 0 && <ClassMap list={list} classes={ctx.classes} mapping={mapping} auto={auto} onMapping={setMapping} />}
            {list.length > 0 && mapped === 0 && (
              <p className="t-xs ge-warn">Ни один класс не сопоставлен — разметка агентом будет недоступна, разведка работает и так.</p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
