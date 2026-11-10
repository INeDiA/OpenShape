import { describe, expect, it } from "vitest";
import { demoDocument } from "./doc";
import { evaluateVariables, resolveDocument } from "./resolve";
import type { Document, ExtrudeFeature, SketchFeature, Variable } from "./types";

const v = (name: string, expr: string): Variable => ({ id: `v_${name}`, name, expr, value: 0 });

describe("variables", () => {
  it("evaluates in dependency order regardless of list order", () => {
    const { scope, errors } = evaluateVariables([v("depth", "width / 2"), v("width", "40")]);
    expect(errors.size).toBe(0);
    expect(scope.get("depth")).toBe(20);
  });

  it("detects cycles and propagates errors", () => {
    const { errors } = evaluateVariables([v("a", "b + 1"), v("b", "a + 1"), v("c", "a * 2")]);
    expect(errors.get("v_a")).toMatch(/Circular/);
    expect(errors.get("v_c")).toBeDefined();
  });
});

describe("resolveDocument", () => {
  it("drives feature parameters and sketch dimensions", () => {
    const base = demoDocument();
    const extrude = base.features.find((f): f is ExtrudeFeature => f.type === "extrude")!;
    const sketch = base.features.find((f): f is SketchFeature => f.type === "sketch")!;
    const length = sketch.sketch.constraints.find((c) => c.kind === "length")!;

    const doc: Document = {
      variables: [v("w", "60"), v("t", "w / 4")],
      features: base.features.map((f) => {
        if (f.id === extrude.id) return { ...f, exprs: { distance: "t" } };
        if (f.id === sketch.id)
          return { ...sketch, sketch: { ...sketch.sketch, constraints: sketch.sketch.constraints.map((c) => (c.id === length.id ? { ...c, expr: "w" } : c)) } };
        return f;
      }),
    };

    let solverCalls = 0;
    const r = resolveDocument(doc, (s) => (solverCalls++, s));
    expect(r.featureErrors.size).toBe(0);
    expect((r.doc.features.find((f) => f.id === extrude.id) as ExtrudeFeature).distance).toBe(15);
    const dim = (r.doc.features.find((f) => f.id === sketch.id) as SketchFeature).sketch.constraints.find((c) => c.id === length.id)!;
    expect("value" in dim && dim.value).toBe(60);
    expect(solverCalls).toBe(1);
    expect(r.doc.variables.map((x) => x.value)).toEqual([60, 15]);
  });

  it("returns the same document when nothing changes", () => {
    const doc = demoDocument();
    expect(resolveDocument(doc).doc).toBe(doc);
  });

  it("reports bad expressions per feature", () => {
    const doc = demoDocument();
    doc.features[1] = { ...doc.features[1], exprs: { distance: "missing * 2" } };
    expect(resolveDocument(doc).featureErrors.get(doc.features[1].id)).toMatch(/Unknown variable/);
  });
});
