import CollapsibleSection from "./CollapsibleSection";
import type { DatasetKind, DatasetSummary } from "../types";

interface Props {
  datasets: DatasetSummary[];
  onUploadClick: () => void;
  onSelect: (kind: DatasetKind, name: string) => void;
  onDelete: (kind: DatasetKind, name: string) => void;
  busy: boolean;
}

export default function DatasetsGrid({
  datasets,
  onUploadClick,
  onSelect,
  onDelete,
  busy,
}: Props) {
  const uploaded = datasets.filter((d) => d.kind === "uploaded");
  const augmented = datasets.filter((d) => d.kind === "augmented");

  return (
    <section className="content">
      <div className="tile-grid">
        <button className="tile tile-add" onClick={onUploadClick} disabled={busy}>
          <span className="tile-add-plus">+</span>
          <span>Загрузить датасет</span>
        </button>
      </div>

      <CollapsibleSection title="Датасеты" count={uploaded.length}>
        {uploaded.length === 0 && <div className="tile-empty">пусто</div>}
        {uploaded.map((d) => (
          <DatasetTile
            key={d.name}
            d={d}
            onSelect={onSelect}
            onDelete={onDelete}
            busy={busy}
          />
        ))}
      </CollapsibleSection>

      <CollapsibleSection title="Аугментированные" count={augmented.length}>
        {augmented.length === 0 && <div className="tile-empty">пусто</div>}
        {augmented.map((d) => (
          <DatasetTile
            key={d.name}
            d={d}
            onSelect={onSelect}
            onDelete={onDelete}
            busy={busy}
          />
        ))}
      </CollapsibleSection>
    </section>
  );
}

function DatasetTile({
  d,
  onSelect,
  onDelete,
  busy,
}: {
  d: DatasetSummary;
  onSelect: Props["onSelect"];
  onDelete: Props["onDelete"];
  busy: boolean;
}) {
  return (
    <div className="tile" onClick={() => onSelect(d.kind, d.name)}>
      <button
        className="tile-del"
        title="Удалить датасет"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          onDelete(d.kind, d.name);
        }}
      >
        ✕
      </button>
      <div className="tile-title">{d.display_name || d.name}</div>
      <div className="tile-meta">
        {d.images.toLocaleString("ru-RU")} изобр.
        {d.num_classes != null ? ` · ${d.num_classes} классов` : ""}
      </div>
      {d.kind === "augmented" && d.source && (
        <div className="tile-sub">из «{d.source}»</div>
      )}
    </div>
  );
}
