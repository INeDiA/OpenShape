import { useState } from "react";
import type { Feature, FeatureStatus } from "../model/types";

interface Props {
  features: Feature[];
  status: Map<string, FeatureStatus>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  /** Drop `id` at `toIndex` (a gap between rows, 0..n). */
  onMove: (id: string, toIndex: number) => void;
  /** Deletes every feature currently in error. */
  onDeleteErrors: (ids: string[]) => void;
}

const ICON: Record<Feature["type"], string> = {
  sketch: "✎",
  extrude: "⬆",
  revolve: "↻",
  sweep: "➰",
  loft: "⏢",
  draft: "⏥",
  boolean: "⊕",
  layflat: "⤓",
  plane: "◱",
  fillet: "◜",
  chamfer: "◸",
  cove: "◟",
  pushpull: "⇕",
  shell: "▢",
  mirror: "⇋",
  pattern: "⁘",
  transform: "✥",
  import: "⇩",
};

export function HistoryPanel({ features, status, selectedId, onSelect, onEdit, onToggle, onDelete, onMove, onDeleteErrors }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const failed = features.filter((f) => status.get(f.id)?.ok === false).map((f) => f.id);

  const endDrag = () => {
    setDragId(null);
    setDropAt(null);
  };

  return (
    <aside className="panel history">
      <h2>
        Design History
        {failed.length > 0 && (
          <button
            className="ghost danger-link"
            title="Delete every feature that fails to rebuild"
            onClick={() => {
              if (confirm(`Delete ${failed.length} feature${failed.length > 1 ? "s" : ""} with errors?`)) onDeleteErrors(failed);
            }}
          >
            Delete {failed.length} with errors
          </button>
        )}
      </h2>
      {features.length === 0 && <p className="muted">Empty. Start with a sketch.</p>}
      <ol
        onDragOver={(e) => {
          if (!dragId) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          // Gap nearest to the pointer: before the row under it, or after it past its middle.
          const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(":scope > li")];
          let at = rows.length;
          for (let i = 0; i < rows.length; i++) {
            const r = rows[i].getBoundingClientRect();
            if (e.clientY < r.top + r.height / 2) {
              at = i;
              break;
            }
          }
          setDropAt(at);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (dragId && dropAt != null) onMove(dragId, dropAt);
          endDrag();
        }}
      >
        {features.map((f, i) => {
          const st = status.get(f.id);
          return (
            <li
              key={f.id}
              draggable
              onDragStart={(e) => {
                setDragId(f.id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", f.name);
              }}
              onDragEnd={endDrag}
              className={[
                f.id === selectedId && "selected",
                f.suppressed && "suppressed",
                st && !st.ok && "error",
                f.id === dragId && "dragging",
                dragId && dropAt === i && "drop-before",
                dragId && dropAt === features.length && i === features.length - 1 && "drop-after",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onSelect(f.id)}
              onDoubleClick={() => onEdit(f.id)}
              title={st?.error ?? "Drag to reorder"}
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
                title="Delete (⌫)"
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
