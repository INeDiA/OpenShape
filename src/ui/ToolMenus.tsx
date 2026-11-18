// The toolbar as a menu bar: a few categories, each opening a list of commands.
// Click a category to open it; while one is open, hovering another switches to it
// (like a desktop menu bar). Escape or a click elsewhere closes it.

import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./icons";

export interface Command {
  id: string;
  label: string;
  icon?: IconName;
  /** Tooltip; for a disabled command, why it can't run now. */
  title?: string;
  shortcut?: string;
  disabled?: boolean;
  /** Shown checked (a choice, e.g. the sketch plane). */
  checked?: boolean;
  run: () => void;
}

export type MenuItem = Command | { heading: string } | "separator";

export interface MenuGroup {
  id: string;
  label: string;
  icon?: IconName;
  title?: string;
  items: MenuItem[];
  hidden?: boolean;
}

const isCommand = (i: MenuItem): i is Command => typeof i === "object" && "run" in i;

export function ToolMenus({ groups }: { groups: MenuGroup[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!bar.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="tool-menus" ref={bar} role="menubar">
      {groups
        .filter((g) => !g.hidden)
        .map((g) => {
          const enabled = g.items.some((i) => isCommand(i) && !i.disabled);
          return (
            <div key={g.id} className={`tool-menu${open === g.id ? " open" : ""}`}>
              <button
                className="tool-menu-button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={open === g.id}
                title={g.title}
                onClick={() => setOpen(open === g.id ? null : g.id)}
                onPointerEnter={() => open && open !== g.id && setOpen(g.id)}
                data-empty={!enabled || undefined}
              >
                {g.icon && <Icon name={g.icon} className="tm-icon" />}
                {g.label}
                <span className="tm-caret">▾</span>
              </button>
              {open === g.id && (
                <div className="tool-menu-list" role="menu">
                  {g.items.map((item, k) =>
                    item === "separator" ? (
                      <div key={k} className="tm-separator" role="separator" />
                    ) : "heading" in item ? (
                      <div key={k} className="tm-heading">
                        {item.heading}
                      </div>
                    ) : (
                      <button
                        key={item.id}
                        role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                        aria-checked={item.checked}
                        className="tm-item"
                        disabled={item.disabled}
                        title={item.title}
                        onClick={() => {
                          setOpen(null);
                          item.run();
                        }}
                      >
                        {item.checked ? <span className="tm-icon tm-check">✓</span> : item.icon ? <Icon name={item.icon} className="tm-icon" /> : <span className="tm-icon" />}
                        <span className="tm-label">{item.label}</span>
                        {item.shortcut && <span className="tm-shortcut">{item.shortcut}</span>}
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}
