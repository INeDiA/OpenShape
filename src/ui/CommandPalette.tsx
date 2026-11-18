// Command palette (⌘K): type a few letters of any command in the toolbar menus
// and run it with Enter. Letters match in order ("ppl" finds Push/Pull);
// commands that can't run now are listed greyed with the reason.

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import type { Command, MenuGroup } from "./ToolMenus";

interface Entry {
  command: Command;
  group: string;
}

/** Score of `query` against `text`: lower is better, null when the letters don't appear in order. */
export function matchScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, ""), t = text.toLowerCase();
  if (!q) return 0;
  const at = t.indexOf(q);
  if (at >= 0) return at === 0 ? 0 : 1 + at / 100; // a substring, best at the start
  let i = 0, gaps = 0, last = -1;
  for (let k = 0; k < t.length && i < q.length; k++) {
    if (t[k] === q[i]) {
      if (last >= 0 && k > last + 1) gaps++;
      last = k;
      i++;
    }
  }
  return i === q.length ? 2 + gaps : null;
}

export function CommandPalette({ groups, onClose }: { groups: MenuGroup[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const entries = useMemo(() => {
    const all: Entry[] = groups
      .filter((g) => !g.hidden)
      .flatMap((g) => g.items.filter((i): i is Command => typeof i === "object" && "run" in i).map((command) => ({ command, group: g.label })));
    return all
      .map((e) => ({ e, score: matchScore(query, e.command.label) ?? Infinity }))
      .filter((x) => x.score < Infinity)
      .sort((a, b) => Number(!!a.e.command.disabled) - Number(!!b.e.command.disabled) || a.score - b.score)
      .map((x) => x.e);
  }, [groups, query]);

  useEffect(() => setIndex(0), [query]);

  const run = (e: Entry | undefined) => {
    if (!e || e.command.disabled) return;
    onClose();
    e.command.run();
  };

  return (
    <div className="palette-backdrop" onPointerDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Commands">
        <div className="palette-search">
          <Icon name="search" />
          <input
            ref={input}
            value={query}
            placeholder="Type a command…"
            aria-label="Command"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") (e.preventDefault(), setIndex((i) => Math.min(entries.length - 1, i + 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setIndex((i) => Math.max(0, i - 1)));
              else if (e.key === "Enter") run(entries[index]);
            }}
          />
        </div>
        <div className="palette-list" role="listbox">
          {entries.length === 0 && <div className="palette-empty">No command matches “{query}”</div>}
          {entries.map((e, k) => (
            <button
              key={`${e.group}-${e.command.id}`}
              role="option"
              aria-selected={k === index}
              className={`palette-item${k === index ? " current" : ""}`}
              disabled={e.command.disabled}
              title={e.command.title}
              onPointerEnter={() => setIndex(k)}
              onClick={() => run(e)}
            >
              {e.command.icon ? <Icon name={e.command.icon} /> : <span className="icon" />}
              <span className="palette-label">{e.command.label}</span>
              {e.command.disabled && e.command.title && <span className="palette-why">{e.command.title}</span>}
              <span className="palette-group">{e.group}</span>
              {e.command.shortcut && <span className="tm-shortcut">{e.command.shortcut}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
