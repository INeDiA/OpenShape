import type { Feature, FeatureStatus } from "../model/types";

interface Props {
  features: Feature[];
  status: Map<string, FeatureStatus>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}

const ICON: Record<Feature["type"], string> = {
  sketch: "✎",
  extrude: "⬆",
  revolve: "↻",
  fillet: "◜",
  chamfer: "◸",
  pushpull: "⇕",
  shell: "▢",
  mirror: "⇋",
  pattern: "⁘",
  import: "⇩",
};

export function HistoryPanel({ features, status, selectedId, onSelect, onEdit, onToggle, onDelete }: Props) {
  return (
    <aside className="panel history">
      <h2>Design History</h2>
      {features.length === 0 && <p className="muted">Empty. Start with a sketch.</p>}
      <ol>
        {features.map((f) => {
          const st = status.get(f.id);
          return (
            <li
              key={f.id}
              className={[f.id === selectedId && "selected", f.suppressed && "suppressed", st && !st.ok && "error"]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onSelect(f.id)}
              onDoubleClick={() => onEdit(f.id)}
              title={st?.error}
            >
              <span className="icon">{ICON[f.type]}</span>
              <span className="name">{f.name}</span>
              {st && !st.ok && <span className="badge">!</span>}
              <button
                className="ghost"
                title={f.suppressed ? "Unsuppress" : "Suppress"}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(f.id);
                }}
              >
                {f.suppressed ? "○" : "●"}
              </button>
              <button
                className="ghost"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(f.id);
                }}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
