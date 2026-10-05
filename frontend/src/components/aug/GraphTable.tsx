// Таблица графов: личная библиотека и графы проекта. Щелчок по строке — редактор.

import type { ReactNode, SyntheticEvent } from "react";
import type { GraphSummary } from "../../api/aug";
import { Button, Popover, Table } from "../../ui";
import { mult } from "./counts";
import { ru } from "../ru";

const when = (iso: string) =>
  new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" }).replace(".", "");

export default function GraphTable({ graphs, onOpen, menu, owner }: {
  graphs: GraphSummary[];
  onOpen: (g: GraphSummary) => void;
  /** Пункты меню «⋯» строки; пусто — меню нет. */
  menu: (g: GraphSummary, close: () => void) => ReactNode;
  /** Колонка владельца — в проекте графы бывают чужие. */
  owner?: boolean;
}) {
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  return (
    <Table className="gl-tbl">
      <thead>
        <tr>
          <th>Граф</th><th>Версия</th><th className="r">Узлов</th><th className="r">Рост</th><th className="r">В наборах</th>
          {owner && <th>Владелец</th>}<th>Создан</th><th />
        </tr>
      </thead>
      <tbody>
        {graphs.map((g) => (
          <tr key={g.id} className="gl-row" tabIndex={0} aria-label={`Граф ${g.name}`} onClick={() => onOpen(g)}
            onKeyDown={(e) => { if (e.key === "Enter") onOpen(g); }}>
            <td className="gl-name">
              <b>{g.name}</b>
              {g.description && <p>{g.description}</p>}
            </td>
            <td>{g.version ? <span className="ui-mono">v{g.version}</span> : <span className="t-xs t-faint">только черновик</span>}</td>
            <td className="r ui-mono">{g.stats ? ru(g.stats.nodes) : "—"}</td>
            <td className="r">{g.stats ? <span className="ui-mono gl-big">{mult(g.stats.multiplier)}</span> : <span className="t-faint">—</span>}</td>
            <td className="r ui-mono">{g.used_by_sets || <span className="t-faint">—</span>}</td>
            {owner && <td className="t-sm">{g.owner ?? <span className="t-faint">без владельца</span>}</td>}
            <td className="gl-when">{when(g.created_at)}</td>
            <td className="r gl-act" onClick={stop} onKeyDown={stop}>
              <Popover align="end" width={280} trigger={<Button size="sm" variant="ghost" icon="more" aria-label={`Действия с графом ${g.name}`} />}>
                {(close) => menu(g, close)}
              </Popover>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
