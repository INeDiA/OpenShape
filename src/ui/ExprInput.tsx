import { useEffect, useState } from "react";
import { evalExpr, isPlainNumber, type Scope } from "../expr/expr";

export interface ExprValue {
  value: number;
  /** undefined when the user typed a plain number */
  expr?: string;
}

interface Props {
  value: number;
  expr?: string;
  scope: Scope;
  min?: number;
  onCommit: (v: ExprValue) => void;
  className?: string;
  autoFocus?: boolean;
  onCancel?: () => void;
}

const fmt = (v: number) => String(Math.round(v * 1e6) / 1e6);

/**
 * Numeric input that also accepts expressions ("width / 2", "3cm").
 * Commits on Enter or blur; invalid input stays in the box, marked as an error.
 */
export function ExprInput({ value, expr, scope, min, onCommit, className, autoFocus, onCancel }: Props) {
  const external = expr ?? fmt(value);
  const [text, setText] = useState(external);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(external);
    setError(null);
  }, [external]);

  const commit = () => {
    const src = text.trim();
    if (src === external) return;
    try {
      const v = evalExpr(src.replace(",", "."), scope);
      if (min !== undefined && v < min) throw new Error(`Must be at least ${min}`);
      setError(null);
      onCommit(isPlainNumber(src) ? { value: v } : { value: v, expr: src });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <span className={`expr-input ${className ?? ""}`}>
      <input
        value={text}
        autoFocus={autoFocus}
        onFocus={(e) => e.target.select()}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setText(external);
            setError(null);
            onCancel?.();
          }
        }}
        className={error ? "invalid" : expr ? "has-expr" : ""}
        title={error ?? (expr ? `= ${fmt(value)}` : undefined)}
        spellCheck={false}
      />
      {expr && !error && <span className="expr-value">= {fmt(value)}</span>}
      {error && <span className="expr-error">{error}</span>}
    </span>
  );
}
