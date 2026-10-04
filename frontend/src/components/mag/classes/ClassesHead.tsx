import type { ReactNode } from "react";
import { PageHeader, Tabs } from "../../../ui";

/** Шапка раздела: «Классы» и «Таги» — вкладки одной страницы, адреса у каждой свои. */
export function ClassesHead({ code, desc, actions }: { code: string; desc?: ReactNode; actions?: ReactNode }) {
  const base = `/projects/${code}`;
  return (
    <>
      <PageHeader title="Классы" desc={desc} actions={actions} />
      <Tabs label="Разделы" items={[
        { to: `${base}/classes`, label: "Классы", end: true },
        { to: `${base}/tags`, label: "Таги", end: true },
      ]} />
    </>
  );
}
