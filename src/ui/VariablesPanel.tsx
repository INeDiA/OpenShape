import { useState } from "react";
import { evalExpr, isValidIdentifier, type Scope } from "../expr/expr";
import type { Variable } from "../model/types";

interface Props {
  variables: Variable[];
  errors: Map<string, string>;
  scope: Scope;
  onChange: (vars: Variable[]) => void;
}

const fmt = (v: number) => String(Math.round(v * 1e4) / 1e4);
let seq = 0;

export function VariablesPanel({ variables, errors, scope, onChange }: Props) {
  const [name, setName] = useState("");
  const [expr, setExpr] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const add = () => {
    const n = name.trim();
    if (!isValidIdentifier(n)) return setAddError("Use letters, digits and _ (not a function or unit name)");
    if (variables.some((v) => v.name === n)) return setAddError(`"${n}" already exists`);
    let value = 0;
    try {
      value = evalExpr(expr || "0", scope);
    } catch (e) {
      return setAddError(e instanceof Error ? e.message : String(e));
    }
    onChange([...variables, { id: `var-${Date.now().toString(36)}-${seq++}`, name: n, expr: expr || "0", value }]);
    setName("");
    setExpr("");
    setAddError(null);
  };

  const update = (id: string, patch: Partial<Variable>) => onChange(variables.map((v) => (v.id === id ? { ...v, ...patch } : v)));

  return (
    <section className="variables">
      <h2>Variables</h2>
      {variables.length === 0 && <p className="muted">Define named values and use them in any parameter, e.g. width / 2.</p>}
      <ul>
        {variables.map((v) => (
          <li key={v.id} className={errors.has(v.id) ? "error" : ""} title={errors.get(v.id)}>
            <span className="var-name">{v.name}</span>
            <VarExpr value={v.expr} onCommit={(e) => update(v.id, { expr: e })} />
            <span className="var-value">{errors.has(v.id) ? "!" : fmt(v.value)}</span>
            <button className="ghost" title="Delete variable" onClick={() => onChange(variables.filter((x) => x.id !== v.id))}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="var-add">
        <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <input placeholder="value or expression" value={expr} onChange={(e) => setExpr(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button onClick={add} title="Add variable">
          +
        </button>
      </div>
      {addError && <p className="error-msg small">{addError}</p>}
    </section>
  );
}

/** Raw expression editor; validation happens when the document resolves. */
function VarExpr({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  const [last, setLast] = useState(value);
  if (value !== last) {
    setLast(value);
    setText(value);
  }
  return (
    <input
      className="var-expr"
      value={text}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text.trim() && text !== value && onCommit(text.trim())}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}
