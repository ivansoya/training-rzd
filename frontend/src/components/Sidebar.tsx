export type View = "datasets" | "augment" | "train" | "inference";

interface Props {
  collapsed: boolean;
  onToggle: () => void;
  view: View;
  onNavigate: (view: View) => void;
}

const NAV: { id: View; label: string }[] = [
  { id: "datasets", label: "Датасеты" },
  { id: "augment", label: "Аугментации" },
  { id: "train", label: "Обучение моделей" },
  { id: "inference", label: "Проверка моделей" },
];

export default function Sidebar({ collapsed, onToggle, view, onNavigate }: Props) {
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

      <nav className="sidebar-nav">
        {NAV.map((n) => (
          <button
            key={n.id}
            className={n.id === view ? "nav-btn active" : "nav-btn"}
            onClick={() => onNavigate(n.id)}
          >
            {n.label}
          </button>
        ))}
      </nav>
    </aside>
  );
}
