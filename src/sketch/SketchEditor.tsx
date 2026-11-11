import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactElement, type WheelEvent as RWheelEvent } from "react";
import type { SketchFeature } from "../model/types";
import { constraintActions, CONSTRAINT_GLYPH, dimensionFor } from "./actions";
import { addArcThrough, addCircle, addConstraint, addEllipse, addLineBetween, addPoint, addRectangle, addSpline, addTangentArc, exitDirection, tangentArcGeom } from "./builders";
import { ellipseGeom, splineBeziers, splinePoints, type Pt } from "./curves";
import { offsetCurves, trimCurve } from "./edit";
import { arcMidpoint } from "./profiles";
import { bounds, hitTest, type Hit } from "./geometry";
import { skId } from "./model";
import type { NewConstraint, SkArc, SkCircle, SkConstraint, SkCurve, SkEllipse, SkLine, SketchData } from "./model";
import { curvePoints, entityMap, isDimension, pointOf, removeConstraints, removeEntities } from "./model";
import { solve, type DragTarget, type SolveResult } from "./solver";
import { evalExpr, isPlainNumber, type Scope } from "../expr/expr";

type Tool = "select" | "line" | "rect" | "circle" | "arc" | "tarc" | "ellipse" | "spline" | "trim";

interface Props {
  feature: SketchFeature;
  scope: Scope;
  /** Edges of the face being sketched on, as 2D segment pairs (x1, y1, x2, y2). */
  reference?: Float32Array;
  onCommit: (sketch: SketchData) => void;
  onExit: () => void;
}

interface View {
  cx: number;
  cy: number;
  /** pixels per mm */
  scale: number;
}

/** In-progress drawing: anchors already placed by the active tool. */
type Pending =
  | { tool: "line"; from: string | null; x: number; y: number; chainStart: string | null }
  | { tool: "rect"; x: number; y: number }
  | { tool: "circle"; center: string | null; x: number; y: number }
  | { tool: "arc"; start: string | null; sx: number; sy: number; end?: { id: string | null; x: number; y: number } }
  /** Tangent arc leaving `curve` at its end point `from`. */
  | { tool: "tarc"; curve: string; from: string }
  | { tool: "ellipse"; cx: number; cy: number; center: string | null; major?: { x: number; y: number } }
  | { tool: "spline"; points: { id: string | null; x: number; y: number }[] }
  | null;

interface DragState {
  base: SketchData;
  points: { id: string; x0: number; y0: number }[];
  startX: number;
  startY: number;
  moved: boolean;
}

interface EditState {
  id: string;
  sx: number;
  sy: number;
  text: string;
}

const SNAP_PX = 9;
const AXIS_SNAP_DEG = 4;
const TOOL_KEYS: Record<string, Tool> = { s: "select", l: "line", r: "rect", c: "circle", a: "arc", g: "tarc", o: "ellipse", p: "spline", k: "trim" };

/** The line or arc ending at point `id` that a tangent arc should continue (the newest one). */
function curveEndingAt(s: SketchData, id: string): string | null {
  for (let i = s.entities.length - 1; i >= 0; i--) {
    const e = s.entities[i];
    if ((e.kind === "line" && (e.p1 === id || e.p2 === id)) || (e.kind === "arc" && (e.start === id || e.end === id))) return e.id;
  }
  return null;
}

const fmt = (v: number) => (Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(2));

export function SketchEditor({ feature, scope, reference, onCommit, onExit }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [sketch, setSketch] = useState<SketchData>(feature.sketch);
  const [status, setStatus] = useState<Omit<SolveResult, "sketch"> | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Pending>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState<Hit | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  /** Offset distance being typed (null when the offset field is closed). */
  const [offsetText, setOffsetText] = useState<string | null>(null);
  const drag = useRef<DragState | null>(null);
  const pan = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);

  const [view, setView] = useState<View>(() => {
    const b = bounds(feature.sketch);
    if (!b) return { cx: 0, cy: 0, scale: 6 };
    return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale: 6 };
  });

  // Follow external changes (undo/redo) unless a drag is in progress.
  useEffect(() => {
    if (!drag.current) setSketch(feature.sketch);
  }, [feature.sketch]);

  // Initial status.
  useEffect(() => {
    const r = solve(feature.sketch);
    setStatus(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = svgRef.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fit the sketch once we know the real size.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || size.w < 50) return;
    fitted.current = true;
    let b = bounds(sketch);
    if (reference?.length) {
      const xs = reference.filter((_, i) => i % 2 === 0), ys = reference.filter((_, i) => i % 2 === 1);
      const rb = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
      b = b ? { minX: Math.min(b.minX, rb.minX), maxX: Math.max(b.maxX, rb.maxX), minY: Math.min(b.minY, rb.minY), maxY: Math.max(b.maxY, rb.maxY) } : rb;
    }
    if (!b) return;
    const w = Math.max(b.maxX - b.minX, 10), h = Math.max(b.maxY - b.minY, 10);
    setView({ cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale: Math.min(size.w / w, size.h / h) * 0.55 });
  }, [size, sketch]);

  const toScreen = useCallback((x: number, y: number) => [size.w / 2 + (x - view.cx) * view.scale, size.h / 2 - (y - view.cy) * view.scale] as const, [size, view]);
  const toWorld = useCallback((sx: number, sy: number) => ({ x: view.cx + (sx - size.w / 2) / view.scale, y: view.cy - (sy - size.h / 2) / view.scale }), [size, view]);

  const eventWorld = (ev: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return toWorld(ev.clientX - r.left, ev.clientY - r.top);
  };

  /** Solves and commits, or rejects the change with a message if it over-constrains the sketch. */
  const apply = useCallback(
    (next: SketchData, what = "change"): boolean => {
      const r = solve(next);
      if (!r.ok || r.conflicting.length) {
        setMessage(`Can't apply ${what}: it conflicts with existing constraints.`);
        return false;
      }
      setMessage(r.redundant.length ? "Some constraints are redundant." : null);
      setSketch(r.sketch);
      setStatus(r);
      onCommit(r.sketch);
      return true;
    },
    [onCommit],
  );

  const snapPoint = (x: number, y: number, exclude?: Set<string>): string | null => {
    const h = hitTest(sketch, x, y, SNAP_PX / view.scale, exclude);
    return h?.kind === "point" ? h.id : null;
  };

  /** Snaps to a vertex of the reference face, if one is close. */
  const refSnap = (x: number, y: number): { x: number; y: number } | null => {
    if (!reference) return null;
    const tol = SNAP_PX / view.scale;
    for (let i = 0; i < reference.length; i += 2) {
      if (Math.hypot(reference[i] - x, reference[i + 1] - y) <= tol) return { x: reference[i], y: reference[i + 1] };
    }
    return null;
  };

  /** Free points snap to a 1 mm grid (finer when zoomed in). */
  const gridSnap = (v: number) => {
    const step = view.scale > 20 ? 0.1 : view.scale > 4 ? 1 : 5;
    return Math.round(v / step) * step;
  };

  const pointAt = (s: SketchData, x: number, y: number): { sketch: SketchData; id: string } => {
    const existing = snapPoint(x, y);
    if (existing) return { sketch: s, id: existing };
    const ref = refSnap(x, y);
    const r = ref ? addPoint(s, ref.x, ref.y) : addPoint(s, gridSnap(x), gridSnap(y));
    return { sketch: r.sketch, id: r.ids[0] };
  };

  const cancelPending = () => setPending(null);

  /** Commits the spline being drawn (needs two points, three when closed). */
  const finishSpline = (placed: { id: string | null; x: number; y: number }[], closed: boolean) => {
    setPending(null);
    if (placed.length < 2) return;
    let s = sketch;
    const ids = placed.map((p) => {
      if (p.id) return p.id;
      const r = addPoint(s, p.x, p.y);
      s = r.sketch;
      return r.ids[0];
    });
    const r = addSpline(s, ids, closed);
    if (r) apply(r.sketch, "spline");
  };

  // ---- pointer handling ----------------------------------------------------

  const onPointerDown = (ev: RPointerEvent) => {
    if (edit) return;
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    const { x, y } = eventWorld(ev);

    if (ev.button === 1 || ev.button === 2 || (ev.button === 0 && ev.altKey)) {
      pan.current = { x: ev.clientX, y: ev.clientY, cx: view.cx, cy: view.cy };
      return;
    }
    if (ev.button !== 0) return;

    if (tool === "select") {
      const h = hitTest(sketch, x, y, SNAP_PX / view.scale);
      if (!h) {
        setSelection(new Set());
        return;
      }
      setSelection((sel) => {
        const n = new Set(ev.shiftKey || ev.metaKey ? sel : sel.has(h.id) ? sel : []);
        if (n.has(h.id) && (ev.shiftKey || ev.metaKey)) n.delete(h.id);
        else n.add(h.id);
        return n;
      });
      const m = entityMap(sketch);
      const e = m.get(h.id)!;
      const ids = e.kind === "point" ? [e.id] : curvePoints(e);
      drag.current = {
        base: sketch,
        points: ids.map((id) => ({ id, x0: pointOf(m, id).x, y0: pointOf(m, id).y })),
        startX: x,
        startY: y,
        moved: false,
      };
      return;
    }

    if (tool === "line") {
      let s = sketch;
      if (!pending || pending.tool !== "line") {
        const snap = snapPoint(x, y);
        const at = snap ? pointOf(s, snap) : { x: gridSnap(x), y: gridSnap(y) };
        setPending({ tool: "line", from: snap, x: at.x, y: at.y, chainStart: snap });
        return;
      }
      let from = pending.from;
      if (!from) {
        const r = addPoint(s, pending.x, pending.y);
        s = r.sketch;
        from = r.ids[0];
      }
      const chainStart = pending.chainStart ?? from;
      const end = pointAt(s, x, y);
      if (end.id === from) return;
      s = end.sketch;
      const line = addLineBetween(s, from, end.id);
      s = line.sketch;
      // Auto horizontal / vertical when nearly axis-aligned.
      const m = entityMap(s);
      const a = pointOf(m, from), b = pointOf(m, end.id);
      const ang = Math.abs((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI);
      if (Math.min(ang, 180 - ang) < AXIS_SNAP_DEG) s = addConstraint(s, { kind: "horizontal", line: line.ids[0] }).sketch;
      else if (Math.abs(ang - 90) < AXIS_SNAP_DEG) s = addConstraint(s, { kind: "vertical", line: line.ids[0] }).sketch;
      if (apply(s, "line")) {
        const ep = pointOf(s, end.id);
        if (end.id === chainStart) setPending(null);
        else setPending({ tool: "line", from: end.id, x: ep.x, y: ep.y, chainStart });
      }
      return;
    }

    if (tool === "rect") {
      if (!pending || pending.tool !== "rect") {
        setPending({ tool: "rect", x: gridSnap(x), y: gridSnap(y) });
        return;
      }
      const x1 = gridSnap(x), y1 = gridSnap(y);
      if (Math.abs(x1 - pending.x) > 1e-6 && Math.abs(y1 - pending.y) > 1e-6) {
        const r = addRectangle(sketch, Math.min(pending.x, x1), Math.min(pending.y, y1), Math.max(pending.x, x1), Math.max(pending.y, y1));
        apply(r.sketch, "rectangle");
      }
      setPending(null);
      return;
    }

    if (tool === "arc") {
      const snap = snapPoint(x, y);
      const at = snap ? pointOf(sketch, snap) : refSnap(x, y) ?? { x: gridSnap(x), y: gridSnap(y) };
      if (!pending || pending.tool !== "arc") {
        setPending({ tool: "arc", start: snap, sx: at.x, sy: at.y });
        return;
      }
      if (!pending.end) {
        if (Math.hypot(at.x - pending.sx, at.y - pending.sy) < 1e-6) return;
        setPending({ ...pending, end: { id: snap, x: at.x, y: at.y } });
        return;
      }
      const r = addArcThrough(sketch, pending.start ?? { x: pending.sx, y: pending.sy }, pending.end.id ?? { x: pending.end.x, y: pending.end.y }, { x, y });
      if (r) apply(r.sketch, "arc");
      else setMessage("The three points are in line: move the cursor off the chord.");
      setPending(null);
      return;
    }

    if (tool === "trim") {
      const h = hitTest(sketch, x, y, SNAP_PX / view.scale);
      if (!h || h.kind === "point") return;
      const r = trimCurve(sketch, h.id, x, y);
      if ("error" in r) setMessage(r.error);
      else apply(r.sketch, "trim");
      setHover(null);
      return;
    }

    if (tool === "tarc") {
      const snap = snapPoint(x, y);
      if (!pending || pending.tool !== "tarc") {
        const curve = snap ? curveEndingAt(sketch, snap) : null;
        if (!snap || !curve) {
          setMessage("Tangent arc: start from the end of a line or arc.");
          return;
        }
        setMessage(null);
        setPending({ tool: "tarc", curve, from: snap });
        return;
      }
      const at = refSnap(x, y) ?? { x: gridSnap(x), y: gridSnap(y) };
      const r = addTangentArc(sketch, pending.curve, pending.from, snap ?? at);
      if (!r) {
        setMessage("The end is straight ahead: a tangent arc needs to turn.");
        return;
      }
      if (apply(r.sketch, "tangent arc")) {
        // Keep going from the new arc's far end, unless the chain closed on an existing point.
        const arc = r.sketch.entities.find((e) => e.id === r.ids[0]) as SkArc;
        const far = arc.start === pending.from ? arc.end : arc.start;
        setPending(snap ? null : { tool: "tarc", curve: arc.id, from: far });
      }
      return;
    }

    if (tool === "ellipse") {
      if (!pending || pending.tool !== "ellipse") {
        const c = snapPoint(x, y);
        const p = c ? pointOf(sketch, c) : { x: gridSnap(x), y: gridSnap(y) };
        setPending({ tool: "ellipse", cx: p.x, cy: p.y, center: c });
        return;
      }
      if (!pending.major) {
        const mx = gridSnap(x), my = gridSnap(y);
        if (Math.hypot(mx - pending.cx, my - pending.cy) < 1e-6) return;
        setPending({ ...pending, major: { x: mx, y: my } });
        return;
      }
      const b = ellipseMinor(pending.cx, pending.cy, pending.major, x, y);
      const r = addEllipse(sketch, pending.cx, pending.cy, pending.major.x, pending.major.y, b);
      if (r) {
        let next = r.sketch;
        // Reuse a snapped center point.
        if (pending.center) {
          const e = next.entities.find((x) => x.id === r.ids[0]) as SkEllipse;
          next = addConstraint(next, { kind: "coincident", a: e.center, b: pending.center }).sketch;
        }
        apply(next, "ellipse");
      }
      setPending(null);
      return;
    }

    if (tool === "spline") {
      const snap = snapPoint(x, y);
      const at = snap ? pointOf(sketch, snap) : refSnap(x, y) ?? { x: gridSnap(x), y: gridSnap(y) };
      const placed = pending?.tool === "spline" ? pending.points : [];
      const last = placed[placed.length - 1];
      // Clicking the last point again (or double clicking) finishes; the first point closes it.
      if (last && Math.hypot(at.x - last.x, at.y - last.y) * view.scale < 4) {
        finishSpline(placed, false);
        return;
      }
      if (placed.length >= 3 && Math.hypot(at.x - placed[0].x, at.y - placed[0].y) * view.scale < SNAP_PX) {
        finishSpline(placed, true);
        return;
      }
      setPending({ tool: "spline", points: [...placed, { id: snap, x: at.x, y: at.y }] });
      return;
    }

    if (tool === "circle") {
      if (!pending || pending.tool !== "circle") {
        const c = snapPoint(x, y);
        const p = c ? pointOf(sketch, c) : { x: gridSnap(x), y: gridSnap(y) };
        setPending({ tool: "circle", center: c, x: p.x, y: p.y });
        return;
      }
      const r = Math.hypot(x - pending.x, y - pending.y);
      if (r > 1e-3) {
        let s = sketch;
        let added;
        if (pending.center) {
          const id = skId("k");
          s = { ...s, entities: [...s.entities, { id, kind: "circle", center: pending.center, radius: r } as SkCircle] };
          added = s;
        } else {
          added = addCircle(s, pending.x, pending.y, r).sketch;
        }
        apply(added, "circle");
      }
      setPending(null);
    }
  };

  const onPointerMove = (ev: RPointerEvent) => {
    const w = eventWorld(ev);
    setCursor(w);
    if (pan.current) {
      const p = pan.current;
      setView((v) => ({ ...v, cx: p.cx - (ev.clientX - p.x) / v.scale, cy: p.cy + (ev.clientY - p.y) / v.scale }));
      return;
    }
    const d = drag.current;
    if (d) {
      const dx = w.x - d.startX, dy = w.y - d.startY;
      if (!d.moved && Math.hypot(dx, dy) * view.scale < 3) return;
      d.moved = true;
      const targets: DragTarget[] = d.points.map((p) => ({ point: p.id, x: p.x0 + dx, y: p.y0 + dy }));
      const r = solve(d.base, targets);
      if (r.ok) setSketch(r.sketch);
      return;
    }
    setHover(hitTest(sketch, w.x, w.y, SNAP_PX / view.scale));
  };

  const onPointerUp = () => {
    pan.current = null;
    const d = drag.current;
    drag.current = null;
    if (d?.moved) {
      // Settle without the temporary drag constraints, then commit.
      if (!apply(sketch, "drag")) setSketch(d.base);
    }
  };

  const onWheel = (ev: RWheelEvent) => {
    const before = eventWorld(ev);
    const factor = Math.exp(-ev.deltaY * 0.0015);
    setView((v) => {
      const scale = Math.min(200, Math.max(0.2, v.scale * factor));
      // Keep the point under the cursor fixed.
      return { scale, cx: before.x - (before.x - v.cx) * (v.scale / scale), cy: before.y - (before.y - v.cy) * (v.scale / scale) };
    });
  };

  // ---- commands --------------------------------------------------------------

  const deleteSelection = useCallback(() => {
    if (!selection.size) return;
    const constraintIds = sketch.constraints.filter((c) => selection.has(c.id)).map((c) => c.id);
    let s = removeConstraints(sketch, constraintIds);
    s = removeEntities(s, [...selection].filter((id) => !constraintIds.includes(id)));
    setSelection(new Set());
    apply(s, "delete");
  }, [selection, sketch, apply]);

  const addConstraints = (cs: NewConstraint[], label: string) => {
    let s = sketch;
    for (const c of cs) s = addConstraint(s, c).sketch;
    if (apply(s, label)) setSelection(new Set());
  };

  const actions = useMemo(() => constraintActions(sketch, selection), [sketch, selection]);
  const dimension = useMemo(() => dimensionFor(sketch, selection), [sketch, selection]);

  const addDimension = () => {
    if (!dimension) return;
    const r = addConstraint(sketch, dimension);
    if (apply(r.sketch, "dimension")) {
      setSelection(new Set());
      const id = r.ids[0];
      // Open the inline editor on the new dimension.
      requestAnimationFrame(() => startEdit(id));
    }
  };

  const applyOffset = () => {
    if (offsetText == null) return;
    const src = offsetText.trim().replace(",", ".");
    setOffsetText(null);
    let d: number;
    try {
      d = evalExpr(src, scope);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      return;
    }
    const r = offsetCurves(sketch, selection, d);
    if ("error" in r) setMessage(r.error);
    else if (apply(r.sketch, "offset")) setSelection(new Set(r.ids));
  };

  const toggleConstruction = () => {
    const entities = sketch.entities.map((e) => (e.kind !== "point" && selection.has(e.id) ? { ...e, construction: !e.construction } : e));
    apply({ ...sketch, entities }, "construction");
  };

  const dimLabelPos = useRef(new Map<string, [number, number]>());
  const startEdit = (id: string) => {
    const c = sketch.constraints.find((x) => x.id === id) ?? null;
    const pos = dimLabelPos.current.get(id);
    if (!pos) return;
    const text = c && isDimension(c) ? (c.expr ?? fmt(c.value)) : "0";
    setEdit({ id, sx: pos[0], sy: pos[1], text });
  };

  const commitEdit = () => {
    if (!edit) return;
    const src = edit.text.trim().replace(",", ".");
    setEdit(null);
    let v: number;
    try {
      v = evalExpr(src, scope);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      return;
    }
    if (v <= 0) {
      setMessage("Dimensions must be positive.");
      return;
    }
    const expr = isPlainNumber(src) ? undefined : src;
    const constraints = sketch.constraints.map((c) => (c.id === edit.id && isDimension(c) ? { ...c, value: v, expr } : c));
    apply({ ...sketch, constraints }, "dimension");
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (edit || (e.target as HTMLElement).tagName === "INPUT") return;
      if (e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if ((k === "escape" || k === "enter") && pending?.tool === "spline") {
        finishSpline(pending.points, false);
        return;
      }
      if (k === "escape") {
        if (pending) cancelPending();
        else if (selection.size) setSelection(new Set());
        else if (tool !== "select") setTool("select");
        else onExit();
        return;
      }
      if (k === "delete" || k === "backspace") {
        e.preventDefault();
        deleteSelection();
        return;
      }
      if (k === "d" && dimension) {
        addDimension();
        return;
      }
      if (k === "x" && selection.size) {
        toggleConstruction();
        return;
      }
      const act = actions.find((a) => a.shortcut === k);
      if (act) {
        addConstraints(act.build(), act.label);
        return;
      }
      if (TOOL_KEYS[k]) {
        setTool(TOOL_KEYS[k]);
        setPending(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- rendering -------------------------------------------------------------

  const m = entityMap(sketch);
  const conflicting = new Set(status?.conflicting ?? []);
  const cls = (id: string, base: string) =>
    [base, selection.has(id) && "sel", hover?.id === id && "hover", conflicting.has(id) && "conflict"].filter(Boolean).join(" ");

  const grid = useMemo(() => {
    const step = view.scale > 20 ? 1 : view.scale > 4 ? 10 : 50;
    const tl = toWorld(0, 0), br = toWorld(size.w, size.h);
    const lines: ReactElement[] = [];
    for (let x = Math.ceil(tl.x / step) * step; x <= br.x; x += step) {
      const [sx] = toScreen(x, 0);
      lines.push(<line key={`gx${x}`} x1={sx} y1={0} x2={sx} y2={size.h} className={Math.abs(x) < 1e-9 ? "axis-y" : "grid"} />);
    }
    for (let y = Math.ceil(br.y / step) * step; y <= tl.y; y += step) {
      const [, sy] = toScreen(0, y);
      lines.push(<line key={`gy${y}`} x1={0} y1={sy} x2={size.w} y2={sy} className={Math.abs(y) < 1e-9 ? "axis-x" : "grid"} />);
    }
    return lines;
  }, [view, size, toScreen, toWorld]);

  // Glyph and dimension placement.
  const glyphs: ReactElement[] = [];
  const dims: ReactElement[] = [];
  const perLine = new Map<string, number>();
  dimLabelPos.current = new Map();

  /** SVG path for a counter-clockwise arc (screen y is flipped, so the sweep flag is 0). */
  function arcPath(a: SkArc): string {
    const c = pointOf(m, a.center), s0 = pointOf(m, a.start), s1 = pointOf(m, a.end);
    const r = Math.hypot(s0.x - c.x, s0.y - c.y);
    let span = Math.atan2(s1.y - c.y, s1.x - c.x) - Math.atan2(s0.y - c.y, s0.x - c.x);
    if (span <= 0) span += Math.PI * 2;
    const [x0, y0] = toScreen(s0.x, s0.y), [x1, y1] = toScreen(s1.x, s1.y);
    const R = r * view.scale;
    return `M ${x0} ${y0} A ${R} ${R} 0 ${span > Math.PI ? 1 : 0} 0 ${x1} ${y1}`;
  }

  /** SVG path of an ellipse or spline (Béziers map exactly under the screen transform). */
  function curvePath(e: Extract<SkCurve, { kind: "ellipse" | "spline" }>, mm = m): string {
    if (e.kind === "ellipse") {
      const g = ellipseGeom(mm, e);
      return ellipseSvg(g.cx, g.cy, g.a, g.b, g.angle);
    }
    return splineSvg(splinePoints(mm, e), !!e.closed);
  }
  const ellipseSvg = (cx: number, cy: number, a: number, b: number, angle: number) => {
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const [x0, y0] = toScreen(cx + a * ca, cy + a * sa), [x1, y1] = toScreen(cx - a * ca, cy - a * sa);
    const A = a * view.scale, B = b * view.scale, deg = (-angle * 180) / Math.PI;
    return `M ${x0} ${y0} A ${A} ${B} ${deg} 1 0 ${x1} ${y1} A ${A} ${B} ${deg} 1 0 ${x0} ${y0} Z`;
  };
  const splineSvg = (pts: Pt[], closed: boolean) => {
    if (pts.length < 2) return "";
    const sc = (p: Pt) => toScreen(p[0], p[1]).join(" ");
    return `M ${sc(pts[0])} ` + splineBeziers(pts, closed).map((b) => `C ${sc(b.c1)} ${sc(b.c2)} ${sc(b.to)}`).join(" ") + (closed ? " Z" : "");
  };

  // Annotations go on the outer side of each line, away from the sketch's center.
  const bb = bounds(sketch);
  const [ocx, ocy] = bb ? toScreen((bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2) : [size.w / 2, size.h / 2];
  const lineFrame = (l: SkLine) => {
    const a = pointOf(m, l.p1), b = pointOf(m, l.p2);
    const [ax, ay] = toScreen(a.x, a.y), [bx, by] = toScreen(b.x, b.y);
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    let nx = -(by - ay) / len, ny = (bx - ax) / len;
    if ((mx - ocx) * nx + (my - ocy) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { mx, my, nx, ny };
  };

  const glyphAtLine = (c: SkConstraint, lineId: string, text: string) => {
    const l = m.get(lineId) as SkLine | undefined;
    if (!l) return;
    const k = perLine.get(lineId) ?? 0;
    perLine.set(lineId, k + 1);
    const f = lineFrame(l);
    // Stack multiple glyphs along the line direction.
    const gx = f.mx + f.nx * 14 + f.ny * k * 18;
    const gy = f.my + f.ny * 14 - f.nx * k * 18;
    glyphs.push(<Glyph key={`${c.id}-${lineId}`} id={c.id} x={gx} y={gy} text={text} cls={cls(c.id, "glyph")} onSelect={selectConstraint} />);
  };

  const glyphAtPoint = (c: SkConstraint, pointId: string, text: string) => {
    const p = m.get(pointId);
    if (!p || p.kind !== "point") return;
    const [sx, sy] = toScreen(p.x, p.y);
    glyphs.push(<Glyph key={`${c.id}-${pointId}`} id={c.id} x={sx + 12} y={sy - 12} text={text} cls={cls(c.id, "glyph")} onSelect={selectConstraint} />);
  };

  function selectConstraint(id: string, additive: boolean) {
    setSelection((sel) => {
      const n = new Set(additive ? sel : []);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  for (const c of sketch.constraints) {
    const g = CONSTRAINT_GLYPH[c.kind];
    switch (c.kind) {
      case "horizontal":
      case "vertical":
        glyphAtLine(c, c.line, g);
        break;
      case "parallel":
      case "perpendicular":
        glyphAtLine(c, c.a, g);
        glyphAtLine(c, c.b, g);
        break;
      case "equal":
        if (m.get(c.a)?.kind === "line") {
          glyphAtLine(c, c.a, g);
          glyphAtLine(c, c.b, g);
        } else {
          for (const id of [c.a, c.b]) {
            const k = m.get(id) as SkCircle;
            const ctr = pointOf(m, k.center);
            const [sx, sy] = toScreen(ctr.x, ctr.y - k.radius);
            glyphs.push(<Glyph key={`${c.id}-${id}`} id={c.id} x={sx} y={sy + 14} text={g} cls={cls(c.id, "glyph")} onSelect={selectConstraint} />);
          }
        }
        break;
      case "tangent":
        glyphAtLine(c, c.line, g);
        break;
      case "coincident":
      case "fixed":
        glyphAtPoint(c, c.kind === "fixed" ? c.point : c.a, g);
        break;
      case "pointOnLine":
      case "pointOnCircle":
      case "midpoint":
      case "tangentAt":
        glyphAtPoint(c, c.point, g);
        break;
      case "length":
      case "distance":
      case "radius":
      case "angle": {
        let sx = 0, sy = 0, text = c.expr ? `ƒ ${fmt(c.value)}` : fmt(c.value);
        let leader: ReactElement | null = null;
        if (c.kind === "length" || c.kind === "angle") {
          const l = m.get(c.kind === "length" ? c.line : c.b) as SkLine | undefined;
          if (!l) break;
          const f = lineFrame(l);
          sx = f.mx + f.nx * 38;
          sy = f.my + f.ny * 38;
          if (c.kind === "angle") text = `${text}°`;
        } else if (c.kind === "distance") {
          const a = pointOf(m, c.a), b = pointOf(m, c.b);
          const [ax, ay] = toScreen(a.x, a.y), [bx, by] = toScreen(b.x, b.y);
          sx = (ax + bx) / 2;
          sy = (ay + by) / 2 - 14;
          leader = <line x1={ax} y1={ay} x2={bx} y2={by} className="dim-line" />;
        } else {
          const k = m.get(c.circle) as SkCircle | SkArc | undefined;
          if (!k) break;
          const ctr = pointOf(m, k.center);
          const [cx, cy] = toScreen(ctr.x, ctr.y);
          const onCurve = k.kind === "arc" ? arcMidpoint(m, k) : ([ctr.x + k.radius * Math.SQRT1_2, ctr.y + k.radius * Math.SQRT1_2] as const);
          const [ex, ey] = toScreen(onCurve[0], onCurve[1]);
          sx = ex + 14;
          sy = ey - 10;
          text = `R${text}`;
          leader = <line x1={cx} y1={cy} x2={ex} y2={ey} className="dim-line" />;
        }
        dimLabelPos.current.set(c.id, [sx, sy]);
        dims.push(
          <g key={c.id}>
            {leader}
            <g
              className={cls(c.id, c.expr ? "dim has-expr" : "dim")}
              transform={`translate(${sx},${sy})`}
              onPointerDown={(e) => {
                e.stopPropagation();
                selectConstraint(c.id, e.shiftKey || e.metaKey);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                startEdit(c.id);
              }}
            >
              <rect x={-text.length * 4 - 5} y={-10} width={text.length * 8 + 10} height={20} rx={4} />
              <text textAnchor="middle" dominantBaseline="central">
                {text}
              </text>
            </g>
          </g>,
        );
        break;
      }
    }
  }

  // Preview of the tool in progress.
  let preview: ReactElement | null = null;
  if (tool === "trim" && hover && hover.kind !== "point" && cursor) {
    const r = trimCurve(sketch, hover.id, cursor.x, cursor.y);
    if (!("error" in r) && r.removed.length > 1) {
      preview = <polyline points={r.removed.map(([px, py]) => toScreen(px, py).join(",")).join(" ")} className="trim-preview" />;
    }
  }
  if (pending && cursor) {
    if (pending.tool === "line") {
      const a = { x: pending.x, y: pending.y };
      const [ax, ay] = toScreen(a.x, a.y);
      const snap = snapPoint(cursor.x, cursor.y);
      const b = snap ? pointOf(m, snap) : { x: gridSnap(cursor.x), y: gridSnap(cursor.y) };
      const [bx, by] = toScreen(b.x, b.y);
      preview = (
        <g>
          <line x1={ax} y1={ay} x2={bx} y2={by} className="preview" />
          <text x={bx + 10} y={by - 10} className="preview-label">
            {fmt(Math.hypot(b.x - a.x, b.y - a.y))}
          </text>
        </g>
      );
    } else if (pending.tool === "rect") {
      const [ax, ay] = toScreen(pending.x, pending.y);
      const [bx, by] = toScreen(gridSnap(cursor.x), gridSnap(cursor.y));
      preview = (
        <g>
          <rect x={Math.min(ax, bx)} y={Math.min(ay, by)} width={Math.abs(bx - ax)} height={Math.abs(by - ay)} className="preview" />
          <text x={bx + 10} y={by - 10} className="preview-label">
            {fmt(Math.abs(gridSnap(cursor.x) - pending.x))} × {fmt(Math.abs(gridSnap(cursor.y) - pending.y))}
          </text>
        </g>
      );
    } else if (pending.tool === "arc") {
      const [ax, ay] = toScreen(pending.sx, pending.sy);
      if (!pending.end) {
        const [bx, by] = toScreen(gridSnap(cursor.x), gridSnap(cursor.y));
        preview = <line x1={ax} y1={ay} x2={bx} y2={by} className="preview" />;
      } else {
        const r = addArcThrough(sketch, { x: pending.sx, y: pending.sy }, { x: pending.end.x, y: pending.end.y }, cursor);
        const arc = r?.sketch.entities.find((e) => e.id === r.ids[0]) as SkArc | undefined;
        if (r && arc) {
          const mm = entityMap(r.sketch);
          const c = pointOf(mm, arc.center), s0 = pointOf(mm, arc.start), s1 = pointOf(mm, arc.end);
          let span = Math.atan2(s1.y - c.y, s1.x - c.x) - Math.atan2(s0.y - c.y, s0.x - c.x);
          if (span <= 0) span += Math.PI * 2;
          const [x0, y0] = toScreen(s0.x, s0.y), [x1, y1] = toScreen(s1.x, s1.y);
          const R = arc.radius * view.scale;
          preview = (
            <g>
              <path d={`M ${x0} ${y0} A ${R} ${R} 0 ${span > Math.PI ? 1 : 0} 0 ${x1} ${y1}`} className="preview" />
              <text x={toScreen(cursor.x, cursor.y)[0] + 10} y={toScreen(cursor.x, cursor.y)[1] - 10} className="preview-label">
                R{fmt(arc.radius)}
              </text>
            </g>
          );
        }
      }
    } else if (pending.tool === "tarc") {
      const from = pointOf(m, pending.from);
      const dir = exitDirection(sketch, pending.curve, pending.from);
      const snap = snapPoint(cursor.x, cursor.y);
      const end = snap ? pointOf(m, snap) : { x: gridSnap(cursor.x), y: gridSnap(cursor.y) };
      const g = dir && tangentArcGeom(from, dir, end);
      const [ex, ey] = toScreen(end.x, end.y);
      if (g) {
        const [x0, y0] = toScreen(from.x, from.y);
        // Sweep from `from` to `end` turning the way the tangent goes.
        const a0 = Math.atan2(from.y - g.cy, from.x - g.cx), a1 = Math.atan2(end.y - g.cy, end.x - g.cx);
        let span = g.ccw ? a1 - a0 : a0 - a1;
        span = ((span % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const R = g.radius * view.scale;
        preview = (
          <g>
            <path d={`M ${x0} ${y0} A ${R} ${R} 0 ${span > Math.PI ? 1 : 0} ${g.ccw ? 0 : 1} ${ex} ${ey}`} className="preview" />
            <text x={ex + 10} y={ey - 10} className="preview-label">
              R{fmt(g.radius)}
            </text>
          </g>
        );
      }
    } else if (pending.tool === "ellipse") {
      const [cx, cy] = toScreen(pending.cx, pending.cy);
      if (!pending.major) {
        const [bx, by] = toScreen(gridSnap(cursor.x), gridSnap(cursor.y));
        preview = (
          <g>
            <line x1={cx} y1={cy} x2={bx} y2={by} className="preview" />
            <text x={bx + 10} y={by - 10} className="preview-label">
              {fmt(Math.hypot(gridSnap(cursor.x) - pending.cx, gridSnap(cursor.y) - pending.cy))}
            </text>
          </g>
        );
      } else {
        const a = Math.hypot(pending.major.x - pending.cx, pending.major.y - pending.cy);
        const b = ellipseMinor(pending.cx, pending.cy, pending.major, cursor.x, cursor.y);
        const angle = Math.atan2(pending.major.y - pending.cy, pending.major.x - pending.cx);
        const [qx, qy] = toScreen(cursor.x, cursor.y);
        preview =
          b > 1e-6 ? (
            <g>
              <path d={ellipseSvg(pending.cx, pending.cy, a, b, angle)} className="preview" />
              <text x={qx + 10} y={qy - 10} className="preview-label">
                {fmt(a)} × {fmt(b)}
              </text>
            </g>
          ) : null;
      }
    } else if (pending.tool === "spline") {
      const snap = snapPoint(cursor.x, cursor.y);
      const c = snap ? pointOf(m, snap) : { x: gridSnap(cursor.x), y: gridSnap(cursor.y) };
      const pts: Pt[] = [...pending.points.map((p) => [p.x, p.y] as Pt), [c.x, c.y]];
      preview = (
        <g>
          <path d={splineSvg(pts, false)} className="preview" />
          {pending.points.map((p, i) => {
            const [px, py] = toScreen(p.x, p.y);
            return <circle key={i} cx={px} cy={py} r={3.5} className="pt" />;
          })}
        </g>
      );
    } else if (pending.tool === "circle") {
      const [cx, cy] = toScreen(pending.x, pending.y);
      const r = Math.hypot(cursor.x - pending.x, cursor.y - pending.y);
      preview = (
        <g>
          <circle cx={cx} cy={cy} r={r * view.scale} className="preview" />
          <text x={cx + r * view.scale + 8} y={cy} className="preview-label">
            R{fmt(r)}
          </text>
        </g>
      );
    }
  }

  const dofText = !status
    ? ""
    : sketch.entities.length === 0
      ? "Empty sketch: pick a tool to start drawing"
      : !status.ok
        ? "Solver failed"
        : status.dof === 0
          ? "Fully constrained"
          : `${status.dof} DOF remaining`;

  return (
    <div className="sketch-editor">
      <div className="sketch-bar">
        <strong>{feature.name}</strong>
        <span className="muted">
          {feature.face ? "on face" : `${feature.plane} plane`}
          {feature.offset ? ` @ ${feature.offset}` : ""}
        </span>
        <div className="group">
          {(
            [
              ["select", "↖ Select", "S"],
              ["line", "╱ Line", "L"],
              ["rect", "▭ Rectangle", "R"],
              ["circle", "◯ Circle", "C"],
              ["arc", "◠ Arc", "A"],
              ["tarc", "◡ Tangent arc", "G"],
              ["ellipse", "⬭ Ellipse", "O"],
              ["spline", "∿ Spline", "P"],
              ["trim", "✂ Trim", "K"],
            ] as const
          ).map(([t, label, key]) => (
            <button key={t} className={tool === t ? "active" : ""} title={`${label} (${key})`} onClick={() => (setTool(t), setPending(null))}>
              {label}
            </button>
          ))}
        </div>
        <div className="group">
          {actions.map((a) => (
            <button key={a.key} title={a.shortcut ? `${a.label} (${a.shortcut.toUpperCase()})` : a.label} onClick={() => addConstraints(a.build(), a.label)}>
              <span className="glyph-icon">{a.glyph}</span> {a.label}
            </button>
          ))}
          {dimension && (
            <button title="Dimension (D)" onClick={addDimension}>
              ↔ Dimension
            </button>
          )}
          {[...selection].some((id) => ["line", "circle", "arc", "ellipse", "spline"].includes(m.get(id)?.kind ?? "")) && (
            <button title="Construction (X)" onClick={toggleConstruction}>
              ┄ Construction
            </button>
          )}
          {[...selection].some((id) => ["line", "circle", "arc"].includes(m.get(id)?.kind ?? "")) &&
            (offsetText == null ? (
              <button title="Offset the selected curves" onClick={() => setOffsetText("5")}>
                ⇉ Offset
              </button>
            ) : (
              <label className="offset-field" title="Positive grows closed shapes, negative shrinks them">
                Offset
                <input
                  autoFocus
                  value={offsetText}
                  onChange={(e) => setOffsetText(e.target.value)}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyOffset();
                    if (e.key === "Escape") setOffsetText(null);
                  }}
                />
                <button onClick={applyOffset}>✓</button>
              </label>
            ))}
          {selection.size > 0 && (
            <button title="Delete (⌫)" onClick={deleteSelection}>
              ✕ Delete
            </button>
          )}
        </div>
        <button className="primary right" onClick={onExit}>
          ✓ Finish sketch
        </button>
      </div>

      <svg
        ref={svgRef}
        className={`sketch-canvas tool-${tool}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
        onDoubleClick={() => {
          if (pending?.tool === "line") setPending(null);
        }}
      >
        {grid}
        {reference &&
          Array.from({ length: reference.length / 4 }, (_, i) => {
            const [ax, ay] = toScreen(reference[i * 4], reference[i * 4 + 1]);
            const [bx, by] = toScreen(reference[i * 4 + 2], reference[i * 4 + 3]);
            return <line key={`ref${i}`} x1={ax} y1={ay} x2={bx} y2={by} className="reference" />;
          })}
        {sketch.entities.map((e) => {
          if (e.kind === "line") {
            const a = pointOf(m, e.p1), b = pointOf(m, e.p2);
            const [ax, ay] = toScreen(a.x, a.y), [bx, by] = toScreen(b.x, b.y);
            return <line key={e.id} x1={ax} y1={ay} x2={bx} y2={by} className={cls(e.id, e.construction ? "curve construction" : "curve")} />;
          }
          if (e.kind === "circle") {
            const c = pointOf(m, e.center);
            const [cx, cy] = toScreen(c.x, c.y);
            return <circle key={e.id} cx={cx} cy={cy} r={e.radius * view.scale} className={cls(e.id, e.construction ? "curve construction" : "curve")} />;
          }
          if (e.kind === "arc") {
            return <path key={e.id} d={arcPath(e)} className={cls(e.id, e.construction ? "curve construction" : "curve")} />;
          }
          if (e.kind === "ellipse" || e.kind === "spline") {
            return <path key={e.id} d={curvePath(e)} className={cls(e.id, e.construction ? "curve construction" : "curve")} />;
          }
          return null;
        })}
        {dims}
        {glyphs}
        {sketch.entities.map((e) => {
          if (e.kind !== "point") return null;
          const [sx, sy] = toScreen(e.x, e.y);
          return <circle key={e.id} cx={sx} cy={sy} r={selection.has(e.id) || hover?.id === e.id ? 5 : 3.5} className={cls(e.id, "pt")} />;
        })}
        {preview}
      </svg>

      {edit && (
        <input
          className="dim-input"
          style={{ left: edit.sx, top: edit.sy + ((svgRef.current?.parentElement?.querySelector(".sketch-bar") as HTMLElement | null)?.offsetHeight ?? 0) }}
          autoFocus
          value={edit.text}
          onChange={(e) => setEdit({ ...edit, text: e.target.value })}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            if (e.key === "Escape") setEdit(null);
          }}
          onBlur={commitEdit}
        />
      )}

      <div className="sketch-status">
        <span className={status?.dof === 0 && sketch.entities.length ? "ok" : ""}>{dofText}</span>
        {conflicting.size > 0 && <span className="error-msg">{conflicting.size} conflicting</span>}
        {message && <span className="error-msg">{message}</span>}
        {cursor && (
          <span className="muted right">
            x {fmt(Math.round(cursor.x * 10) / 10)} · y {fmt(Math.round(cursor.y * 10) / 10)}
          </span>
        )}
      </div>
    </div>
  );
}

function Glyph({ id, x, y, text, cls, onSelect }: { id: string; x: number; y: number; text: string; cls: string; onSelect: (id: string, additive: boolean) => void }) {
  return (
    <g
      className={cls}
      transform={`translate(${x},${y})`}
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect(id, e.shiftKey || e.metaKey);
      }}
    >
      <rect x={-8} y={-8} width={16} height={16} rx={3} />
      <text textAnchor="middle" dominantBaseline="central">
        {text}
      </text>
    </g>
  );
}

/** Minor radius from the cursor: its distance to the major axis line. */
function ellipseMinor(cx: number, cy: number, major: { x: number; y: number }, x: number, y: number): number {
  const a = Math.hypot(major.x - cx, major.y - cy) || 1;
  const ux = (major.x - cx) / a, uy = (major.y - cy) / a;
  return Math.abs(-(x - cx) * uy + (y - cy) * ux);
}
