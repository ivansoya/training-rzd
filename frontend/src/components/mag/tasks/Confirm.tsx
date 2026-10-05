// Подтверждение окном вместо window.confirm: вопрос — промис, ответ — кнопка.

import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { Button, Dialog } from "../../../ui";
import type { IconName } from "../../../ui";

interface Ask {
  title: string;
  desc?: ReactNode;
  lines?: string[];
  ok: string;
  icon?: IconName;
  danger?: boolean;
}

export function useConfirm(): [(a: Ask) => Promise<boolean>, ReactNode] {
  const [ask, setAsk] = useState<(Ask & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback((a: Ask) => new Promise<boolean>((resolve) => setAsk({ ...a, resolve })), []);
  const answer = (v: boolean) => { ask?.resolve(v); setAsk(null); };
  const node = ask && (
    <Dialog open onOpenChange={(v) => { if (!v) answer(false); }} width={460} title={ask.title} desc={ask.desc}
      footer={<>
        <Button variant="ghost" onClick={() => answer(false)}>Отмена</Button>
        <Button variant={ask.danger ? "danger" : "primary"} icon={ask.icon} data-autofocus
          onClick={() => answer(true)}>{ask.ok}</Button>
      </>}>
      {ask.lines?.length ? <ul className="tp-ask">{ask.lines.map((l) => <li key={l}>{l}</li>)}</ul> : null}
    </Dialog>
  );
  return [confirm, node];
}
