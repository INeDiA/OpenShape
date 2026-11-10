// Evaluates variables and expression-driven parameters into plain numbers.
// The kernel only ever sees numbers; expressions live in the document.

import { dependencies, evalExpr, ExprError, parse, type Scope } from "../expr/expr";
import { isDimension, type SketchData } from "../sketch/model";
import type { Document, Feature, Variable } from "./types";

export interface Resolution {
  doc: Document;
  scope: Scope;
  /** variable id -> message */
  variableErrors: Map<string, string>;
  /** feature id -> message (bad expression in a parameter or sketch dimension) */
  featureErrors: Map<string, string>;
}

/** Re-solves a sketch after dimension values changed; returns null when it can't be solved. */
export type SketchSolver = (s: SketchData) => SketchData | null;

const message = (e: unknown) => (e instanceof ExprError || e instanceof Error ? e.message : String(e));

/** Evaluates variables in dependency order; cycles and bad references become errors. */
export function evaluateVariables(vars: Variable[]): { scope: Map<string, number>; errors: Map<string, string>; values: Map<string, number> } {
  const byName = new Map(vars.map((v) => [v.name, v]));
  const scope = new Map<string, number>();
  const errors = new Map<string, string>();
  const values = new Map<string, number>();
  const state = new Map<string, "visiting" | "done">();

  const visit = (v: Variable): void => {
    if (state.get(v.id) === "done") return;
    if (state.get(v.id) === "visiting") throw new ExprError(`Circular reference through "${v.name}"`);
    state.set(v.id, "visiting");
    try {
      const ast = parse(v.expr);
      for (const dep of dependencies(ast)) {
        const d = byName.get(dep);
        if (!d) continue; // reported by evalExpr below
        visit(d);
        if (errors.has(d.id)) throw new ExprError(`Depends on "${d.name}", which has an error`);
      }
      const value = evalExpr(v.expr, scope);
      scope.set(v.name, value);
      values.set(v.id, value);
    } catch (e) {
      errors.set(v.id, message(e));
      if (e instanceof ExprError && /^Circular/.test(e.message)) {
        state.set(v.id, "done");
        throw e;
      }
    }
    state.set(v.id, "done");
  };

  for (const v of vars) {
    try {
      visit(v);
    } catch (e) {
      if (!errors.has(v.id)) errors.set(v.id, message(e));
    }
  }
  return { scope, errors, values };
}

export function resolveDocument(doc: Document, solveSketch?: SketchSolver): Resolution {
  const { scope, errors: variableErrors, values } = evaluateVariables(doc.variables);
  const featureErrors = new Map<string, string>();

  let varsChanged = false;
  const variables = doc.variables.map((v) => {
    const value = values.get(v.id);
    if (value === undefined || value === v.value) return v;
    varsChanged = true;
    return { ...v, value };
  });

  let featuresChanged = false;
  const features = doc.features.map((f): Feature => {
    let next = f;
    // Plain numeric parameters.
    for (const [field, src] of Object.entries(f.exprs ?? {})) {
      if (!src) continue;
      try {
        const v = evalExpr(src, scope);
        if ((next as unknown as Record<string, unknown>)[field] !== v) next = { ...next, [field]: v } as Feature;
      } catch (e) {
        featureErrors.set(f.id, `${field}: ${message(e)}`);
      }
    }
    // Sketch dimensions.
    if (next.type === "sketch") {
      let dimsChanged = false;
      const constraints = next.sketch.constraints.map((c) => {
        if (!isDimension(c) || !c.expr) return c;
        try {
          const v = evalExpr(c.expr, scope);
          if (v === c.value) return c;
          dimsChanged = true;
          return { ...c, value: v };
        } catch (e) {
          featureErrors.set(f.id, `dimension: ${message(e)}`);
          return c;
        }
      });
      if (dimsChanged) {
        const updated = { ...next.sketch, constraints };
        const solved = solveSketch ? solveSketch(updated) : updated;
        if (solved) next = { ...next, sketch: solved };
        else featureErrors.set(f.id, "Sketch can't be solved with the new dimension values");
      }
    }
    if (next !== f) featuresChanged = true;
    return next;
  });

  const out = varsChanged || featuresChanged ? { ...doc, variables, features } : doc;
  return { doc: out, scope, variableErrors, featureErrors };
}
