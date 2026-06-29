import type { DatasetKind, DatasetSummary } from "../types";

interface Props {
  collapsed: boolean;
  onToggle: () => void;
  datasets: DatasetSummary[];
  selected: { kind: DatasetKind; name: string } | null;
  onSelect: (kind: DatasetKind, name: string) => void;
  onDelete: (kind: DatasetKind, name: string) => void;
  onUploadClick: () => void;
  onAugmentClick: () => void;
  onTrainClick: () => void;
  onInferenceClick: () => void;
  busy: boolean;
}

export default function Sidebar({
  collapsed,
  onToggle,
  datasets,
  selected,
  onSelect,
  onDelete,
  onUploadClick,
  onAugmentClick,
  onTrainClick,
  onInferenceClick,
  busy,
}: Props) {
  const uploaded = datasets.filter((d) => d.kind === "uploaded");
  const augmented = datasets.filter((d) => d.kind === "augmented");

  if (collapsed) {
    return (
      <aside className="sidebar collapsed">
        <button className="icon-btn" onClick={onToggle} title="Развернуть меню">
          ☰
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <button className="icon-btn" onClick={onToggle} title="Свернуть меню">
          ☰
        </button>
        <span className="sidebar-title">Меню</span>
      </div>

      <div className="sidebar-actions">
        <button className="btn btn-primary block" onClick={onUploadClick} disabled={busy}>
          Загрузить датасет
        </button>
        <button className="btn block" onClick={onAugmentClick} disabled={busy}>
          Настроить аугментации
        </button>
        <button className="btn block" onClick={onTrainClick} disabled={busy}>
          Обучение моделей
        </button>
        <button className="btn block" onClick={onInferenceClick} disabled={busy}>
          Проверка моделей
        </button>
      </div>

      <Group
        title="Загруженные"
        kind="uploaded"
        items={uploaded}
        selected={selected}
        onSelect={onSelect}
        onDelete={onDelete}
        busy={busy}
      />
      <Group
        title="Аугментированные"
        kind="augmented"
        items={augmented}
        selected={selected}
        onSelect={onSelect}
        onDelete={onDelete}
        busy={busy}
      />
    </aside>
  );
}

function Group({
  title,
  kind,
  items,
  selected,
  onSelect,
  onDelete,
  busy,
}: {
  title: string;
  kind: DatasetKind;
  items: DatasetSummary[];
  selected: Props["selected"];
  onSelect: Props["onSelect"];
  onDelete: Props["onDelete"];
  busy: boolean;
}) {
  return (
    <div className="group">
      <div className="group-header">
        {title} <span className="count">{items.length}</span>
      </div>
      <ul className="dataset-list">
        {items.length === 0 && <li className="empty">пусто</li>}
        {items.map((d) => {
          const active = selected?.kind === kind && selected?.name === d.name;
          return (
            <li
              key={d.name}
              className={active ? "dataset-item active" : "dataset-item"}
              onClick={() => onSelect(kind, d.name)}
            >
              <div className="dataset-info">
                <span className="dataset-name">
                  {d.display_name || d.name}
                </span>
                <span className="dataset-meta">
                  {d.images} изобр.
                  {d.kind === "augmented" && d.source ? ` · из «${d.source}»` : ""}
                </span>
              </div>
              <button
                className="del-btn"
                title="Удалить датасет"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(kind, d.name);
                }}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
