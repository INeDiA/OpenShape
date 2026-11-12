// Drawing mode: the sheet with its views and dimensions, and the panel to edit it.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Document, DrawingDimension, DrawingSheet, DrawingView, ViewDir, ViewProjection } from "../model/types";
import {
  arrange,
  defaultSheet,
  dragOffset,
  formatValue,
  newDimensionId,
  newViewId,
  paperSize,
  placeLinear,
  SCALES,
  scaleLabel,
  sheetPrims,
  snapCircle,
  snapPoint,
  toPaper,
  toView,
  viewBox,
  viewName,
  type P2,
  type Prim,
} from "./sheet";
import { sheetDXF, sheetPDF, sheetSVG } from "./export";
import { downloadBlob } from "../io/storage";

interface Props {
  doc: Document;
  commit: (doc: Document) => void;
  project: (doc: Document, dirs: ViewDir[]) => Promise<ViewProjection[]>;
  name: string;
  flash: (msg: string) => void;
}

const DEFAULT_DIRS: ViewDir[] = ["front", "top", "left", "right", "iso"];
const ALL_DIRS: ViewDir[] = ["front", "back", "top", "bottom", "left", "right", "iso"];

/** Placing a dimension: picked points so far. */
type Pending = { view: string; a: P2; b?: P2; circle?: boolean; r?: number } | null;

type Drag = { kind: "view"; id: string; start: P2; from: P2 } | { kind: "dim"; id: string } | { kind: "pan"; start: [number, number]; box: Box } | null;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** On-screen stroke width (px) for a primitive width (mm): true widths are too thin when zoomed out. */
const screenWidth = (mm: number) => Math.max(0.8, mm * 2.4);

export function DrawingWorkspace({ doc, commit, project, name, flash }: Props) {
  const sheet = doc.drawing;
  const [projections, setProjections] = useState<Map<ViewDir, ViewProjection>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- projections: whenever the model or the set of view directions changes ----
  const dirs = useMemo(() => (sheet ? [...new Set(sheet.views.map((v) => v.dir))] : DEFAULT_DIRS), [sheet]);
  const modelKey = useMemo(() => JSON.stringify([doc.variables, doc.features]), [doc.variables, doc.features]);
  const dirsKey = dirs.join(",");
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      project({ variables: doc.variables, features: doc.features }, dirs)
        .then((views) => {
          if (!alive) return;
          setProjections(new Map(views.map((v) => [v.dir, v])));
          setError(null);
        })
        .catch((e) => alive && setError(String(e instanceof Error ? e.message : e)))
        .finally(() => alive && setLoading(false));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey, dirsKey]);

  // First visit: a sheet with the standard views.
  useEffect(() => {
    if (!sheet && projections.size && DEFAULT_DIRS.every((d) => projections.has(d))) {
      if (![...projections.values()].some((p) => p.bounds)) return;
      commit({ ...doc, drawing: defaultSheet(projections, name) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, projections]);

  if (!sheet) {
    return (
      <>
        <main className="stage drawing-stage">
          <div className="overlay busy-indicator">{error ? `Can't project the model: ${error}` : loading ? "Projecting the model…" : "Add a solid to the model to draw it"}</div>
        </main>
        <aside className="panel props">
          <h2>Drawing</h2>
        </aside>
      </>
    );
  }

  return <SheetEditor doc={doc} sheet={sheet} projections={projections} loading={loading} error={error} commit={commit} name={name} flash={flash} />;
}

interface EditorProps {
  doc: Document;
  sheet: DrawingSheet;
  projections: Map<ViewDir, ViewProjection>;
  loading: boolean;
  error: string | null;
  commit: (doc: Document) => void;
  name: string;
  flash: (msg: string) => void;
}

function SheetEditor({ doc, sheet, projections, loading, error, commit, name, flash }: EditorProps) {
  const [tool, setTool] = useState<"select" | "dimension">("select");
  const [selected, setSelected] = useState<{ kind: "view" | "dim"; id: string } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [hover, setHover] = useState<{ paper: P2; snap: P2 | null; view: string | null; circle: boolean } | null>(null);
  const [drag, setDrag] = useState<Drag>(null);
  // Edits shown while dragging, committed on release.
  const [live, setLive] = useState<DrawingSheet | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [shift, setShift] = useState(false);

  const shown = live ?? sheet;
  const [W, H] = paperSize(shown);
  // Fit the sheet when it first appears or changes size.
  useEffect(() => setBox({ x: -10, y: -10, w: W + 20, h: H + 20 }), [W, H]);
  const { prims, dims } = useMemo(() => sheetPrims(shown, projections), [shown, projections]);

  const update = (patch: Partial<DrawingSheet>) => commit({ ...doc, drawing: { ...sheet, ...patch } });

  // ---- coordinates --------------------------------------------------------------
  const toPaperPt = (clientX: number, clientY: number): P2 => {
    const svg = svgRef.current!;
    const m = svg.getScreenCTM()!.inverse();
    const p = new DOMPoint(clientX, clientY).matrixTransform(m);
    return [p.x, H - p.y];
  };
  /** Paper mm per screen pixel. */
  const mmPerPx = () => {
    const svg = svgRef.current;
    if (!svg || !box) return 0.5;
    const r = svg.getBoundingClientRect();
    return Math.max(box.w / r.width, box.h / r.height);
  };
  const viewAt = (p: P2, margin = 3): DrawingView | null => {
    for (const v of [...shown.views].reverse()) {
      const b = viewBox(v, projections.get(v.dir), shown.scale);
      if (p[0] >= b.x0 - margin && p[0] <= b.x1 + margin && p[1] >= b.y0 - margin && p[1] <= b.y1 + margin) return v;
    }
    return null;
  };

  /** Snap under the pointer in dimension mode: a point, or a circle (for diameters). */
  const snapAt = (p: P2) => {
    const v = pending ? shown.views.find((x) => x.id === pending.view) ?? null : viewAt(p);
    if (!v) return { view: null, snap: null, circle: false };
    const proj = projections.get(v.dir);
    const q = toView(v, proj, shown.scale, p);
    const tol = (8 * mmPerPx()) / shown.scale;
    const pt = snapPoint(proj, q, tol);
    if (pt) return { view: v.id, snap: pt, circle: false };
    if (!pending) {
      const c = snapCircle(proj, q, tol);
      if (c) return { view: v.id, snap: [c.cx, c.cy] as P2, circle: true, r: c.r };
    }
    return { view: v.id, snap: null, circle: false };
  };

  // ---- dimension being placed ---------------------------------------------------
  const preview: DrawingDimension | null = (() => {
    if (!pending || !hover) return null;
    const v = shown.views.find((x) => x.id === pending.view)!;
    const proj = projections.get(v.dir);
    if (pending.circle) return { id: "preview", view: v.id, kind: "diameter", a: pending.a, r: pending.r, offset: dragOffset(shown, { id: "", view: v.id, kind: "diameter", a: pending.a, offset: 0 }, projections, hover.paper) };
    if (!pending.b) return null;
    const A = toPaper(v, proj, shown.scale, pending.a), B = toPaper(v, proj, shown.scale, pending.b);
    const { kind, offset } = placeLinear(A, B, hover.paper, shift);
    return { id: "preview", view: v.id, kind, a: pending.a, b: pending.b, offset };
  })();
  const previewPrims = useMemo(() => (preview ? sheetPrims({ ...shown, dimensions: [preview] }, projections).dims[0]?.prims ?? [] : []), [preview, shown, projections]);

  // ---- pointer ------------------------------------------------------------------
  const onPointerDown = (e: React.PointerEvent) => {
    const p = toPaperPt(e.clientX, e.clientY);
    if (e.button === 1 || e.button === 2) {
      setDrag({ kind: "pan", start: [e.clientX, e.clientY], box: box! });
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    if (tool === "dimension") {
      const s = snapAt(p);
      if (!pending) {
        if (s.view && s.snap) setPending({ view: s.view, a: s.snap, circle: s.circle, r: s.r });
        return;
      }
      if (pending.circle) {
        if (preview) addDimension(preview);
        return;
      }
      if (!pending.b) {
        if (s.snap && (s.snap[0] !== pending.a[0] || s.snap[1] !== pending.a[1])) setPending({ ...pending, b: s.snap });
        return;
      }
      if (preview) addDimension(preview);
      return;
    }
    // Select tool: a dimension, else a view, else nothing.
    const dimId = (e.target as Element).closest?.("[data-dim]")?.getAttribute("data-dim");
    if (dimId) {
      setSelected({ kind: "dim", id: dimId });
      setDrag({ kind: "dim", id: dimId });
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    const v = viewAt(p);
    if (v) {
      setSelected({ kind: "view", id: v.id });
      setDrag({ kind: "view", id: v.id, start: p, from: [v.x, v.y] });
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    setSelected(null);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toPaperPt(e.clientX, e.clientY);
    setShift(e.shiftKey);
    if (drag?.kind === "pan") {
      const r = svgRef.current!.getBoundingClientRect();
      const k = Math.max(drag.box.w / r.width, drag.box.h / r.height);
      setBox({ ...drag.box, x: drag.box.x - (e.clientX - drag.start[0]) * k, y: drag.box.y - (e.clientY - drag.start[1]) * k });
      return;
    }
    if (drag?.kind === "view") {
      const nx = drag.from[0] + p[0] - drag.start[0], ny = drag.from[1] + p[1] - drag.start[1];
      setLive({ ...sheet, views: sheet.views.map((v) => (v.id === drag.id ? { ...v, x: nx, y: ny } : v)) });
      return;
    }
    if (drag?.kind === "dim") {
      const d = sheet.dimensions.find((x) => x.id === drag.id);
      if (d) setLive({ ...sheet, dimensions: sheet.dimensions.map((x) => (x.id === d.id ? { ...x, offset: dragOffset(sheet, d, projections, p) } : x)) });
      return;
    }
    if (tool === "dimension") setHover({ paper: p, ...snapAt(p) });
    else setHover(null);
  };

  const onPointerUp = () => {
    if (live) commit({ ...doc, drawing: live });
    setLive(null);
    setDrag(null);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!box) return;
    const p = toPaperPt(e.clientX, e.clientY);
    const k = Math.exp(e.deltaY * 0.0015);
    const sx = p[0], sy = H - p[1];
    setBox({ x: sx - (sx - box.x) * k, y: sy - (sy - box.y) * k, w: box.w * k, h: box.h * k });
  };

  const addDimension = (d: DrawingDimension) => {
    update({ dimensions: [...sheet.dimensions, { ...d, id: newDimensionId() }] });
    setPending(null);
  };

  const removeSelected = () => {
    if (!selected) return;
    if (selected.kind === "dim") update({ dimensions: sheet.dimensions.filter((d) => d.id !== selected.id) });
    else update({ views: sheet.views.filter((v) => v.id !== selected.id), dimensions: sheet.dimensions.filter((d) => d.view !== selected.id) });
    setSelected(null);
  };

  // Keyboard: D dimension tool, Esc cancel, Delete removes the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT") return;
      if (e.key === "Escape") {
        if (pending) setPending(null);
        else if (tool === "dimension") setTool("select");
        else setSelected(null);
      } else if (e.key === "d" || e.key === "D") {
        setTool((t) => (t === "dimension" ? "select" : "dimension"));
        setPending(null);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault();
        removeSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- exports --------------------------------------------------------------------
  const exportSheet = (format: "svg" | "pdf" | "dxf") => {
    const { prims: all } = sheetPrims(sheet, projections);
    const blob =
      format === "svg"
        ? new Blob([sheetSVG(sheet, all)], { type: "image/svg+xml" })
        : format === "pdf"
          ? new Blob([sheetPDF(sheet, all) as BlobPart], { type: "application/pdf" })
          : new Blob([sheetDXF(all)], { type: "application/dxf" });
    downloadBlob(blob, `${name}-drawing.${format}`);
    flash(`Exported ${name}-drawing.${format}`);
  };

  // ---- rendering --------------------------------------------------------------------
  const Y = (y: number) => H - y;
  const detached = new Set(dims.filter((d) => d.detached).map((d) => d.dim.id));
  const colour = (p: Prim) => (p.ref && selected?.id === p.ref ? "#2f6fed" : p.ref && detached.has(p.ref) ? "#e5484d" : "#1d2633");
  const draw = (p: Prim, i: number, extra?: string) => {
    const c = extra ?? colour(p);
    if (p.kind === "line")
      return (
        <line key={i} x1={p.a[0]} y1={Y(p.a[1])} x2={p.b[0]} y2={Y(p.b[1])} stroke={c} strokeWidth={screenWidth(p.width)} strokeDasharray={p.dash ? "6 3" : undefined} vectorEffect="non-scaling-stroke" strokeLinecap="round" />
      );
    if (p.kind === "tri") return <polygon key={i} points={p.pts.map((q) => `${q[0]},${Y(q[1])}`).join(" ")} fill={c} />;
    return (
      <text key={i} transform={`translate(${p.at[0]} ${Y(p.at[1])}) rotate(${-(p.angle ?? 0)})`} fontSize={p.size} textAnchor={p.anchor} fill={c} fontFamily="Helvetica, Arial, sans-serif">
        {p.text}
      </text>
    );
  };
  const byDim = new Map<string, Prim[]>();
  const rest: Prim[] = [];
  for (const p of prims) {
    if (p.ref && sheet.dimensions.some((d) => d.id === p.ref)) byDim.set(p.ref, [...(byDim.get(p.ref) ?? []), p]);
    else rest.push(p);
  }
  const selView = selected?.kind === "view" ? shown.views.find((v) => v.id === selected.id) : null;
  const selDim = selected?.kind === "dim" ? dims.find((d) => d.dim.id === selected.id) : null;
  const pendingView = pending ? shown.views.find((v) => v.id === pending.view) : null;

  return (
    <>
      <main className="stage drawing-stage">
        <div className="drawing-tools">
          <button className={tool === "select" ? "active" : ""} onClick={() => (setTool("select"), setPending(null))} title="Select and move views and dimensions">
            ↖ Select
          </button>
          <button className={tool === "dimension" ? "active" : ""} onClick={() => (setTool("dimension"), setPending(null), setSelected(null))} title="Dimension (D): click two points, or a circle, then place it. Shift: aligned">
            ↔ Dimension
          </button>
          <button onClick={() => setBox({ x: -10, y: -10, w: W + 20, h: H + 20 })} title="Fit the sheet">
            ⤢ Fit
          </button>
          {loading && <span className="muted">Updating views…</span>}
          {error && <span className="error-msg">{error}</span>}
        </div>
        <svg
          ref={svgRef}
          className={`sheet${tool === "dimension" ? " dimensioning" : ""}`}
          viewBox={box ? `${box.x} ${box.y} ${box.w} ${box.h}` : `0 0 ${W} ${H}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setHover(null)}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
        >
          <rect x={0} y={0} width={W} height={H} fill="#fff" className="paper" />
          {rest.map((p, i) => draw(p, i))}
          {[...byDim].map(([id, ps]) => (
            <g key={id} data-dim={id} className="dim">
              {ps.map((p, i) => draw(p, i))}
              {/* Wide invisible strokes make thin dimension lines easy to grab. */}
              {ps.map((p, i) => (p.kind === "line" ? <line key={`h${i}`} x1={p.a[0]} y1={Y(p.a[1])} x2={p.b[0]} y2={Y(p.b[1])} stroke="transparent" strokeWidth={10} vectorEffect="non-scaling-stroke" /> : null))}
            </g>
          ))}
          {selView &&
            (() => {
              const b = viewBox(selView, projections.get(selView.dir), shown.scale);
              return <rect x={b.x0 - 3} y={Y(b.y1 + 3)} width={b.x1 - b.x0 + 6} height={b.y1 - b.y0 + 6} fill="none" stroke="#2f6fed" strokeDasharray="4 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />;
            })()}
          {previewPrims.map((p, i) => draw(p, i, "#2f6fed"))}
          {pending && pendingView && (
            <circle cx={toPaper(pendingView, projections.get(pendingView.dir), shown.scale, pending.a)[0]} cy={Y(toPaper(pendingView, projections.get(pendingView.dir), shown.scale, pending.a)[1])} r={1.2} fill="#2f6fed" />
          )}
          {tool === "dimension" &&
            hover?.snap &&
            hover.view &&
            (() => {
              const v = shown.views.find((x) => x.id === hover.view)!;
              const q = toPaper(v, projections.get(v.dir), shown.scale, hover.snap);
              return <circle cx={q[0]} cy={Y(q[1])} r={1.5} fill="none" stroke={hover.circle ? "#8e6cf0" : "#2f6fed"} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />;
            })()}
        </svg>
        {tool === "dimension" && (
          <div className="overlay picking-banner">
            {!pending
              ? "Click a point, or a circle for its diameter"
              : pending.circle
                ? "Move to place the diameter, then click"
                : !pending.b
                  ? "Click the second point"
                  : "Move to place the dimension and click · Shift: aligned · Esc: cancel"}
          </div>
        )}
      </main>

      <aside className="panel props drawing-panel">
        <h2>Drawing</h2>
        <TextField label="Title" value={sheet.title} onCommit={(title) => update({ title })} />
        <TextField label="Author" value={sheet.author} onCommit={(author) => update({ author })} />
        <label className="field">
          <span>Sheet</span>
          <select value={sheet.size} onChange={(e) => update({ size: e.target.value as DrawingSheet["size"] })}>
            {(["A4", "A3", "A2", "A1"] as const).map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Orientation</span>
          <select value={sheet.orientation} onChange={(e) => update({ orientation: e.target.value as DrawingSheet["orientation"] })}>
            <option value="landscape">Landscape</option>
            <option value="portrait">Portrait</option>
          </select>
        </label>
        <label className="field">
          <span>Scale</span>
          <select value={sheet.scale} onChange={(e) => update({ scale: Number(e.target.value) })}>
            {[...new Set([...SCALES, sheet.scale])].sort((a, b) => b - a).map((k) => (
              <option key={k} value={k}>
                {scaleLabel(k)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Projection</span>
          <select value={sheet.projection} onChange={(e) => update({ projection: e.target.value as DrawingSheet["projection"] })}>
            <option value="first">First angle (ISO)</option>
            <option value="third">Third angle (US)</option>
          </select>
        </label>
        <button
          className="wide"
          title="Put the standard views back in place and pick the scale again (dimensions on removed views are dropped)"
          onClick={() => {
            const { views, scale } = arrange(sheet, projections);
            // Keep dimensions of views that are still there (same direction).
            const byDir = new Map(views.map((v) => [v.dir, v.id]));
            const dimensions = sheet.dimensions.flatMap((d) => {
              const old = sheet.views.find((v) => v.id === d.view);
              const id = old && byDir.get(old.dir);
              return id ? [{ ...d, view: id }] : [];
            });
            update({ views, scale, dimensions });
          }}
        >
          Auto layout
        </button>
        <AddView onAdd={(dir) => update({ views: [...sheet.views, { id: newViewId(), dir, x: W / 2, y: H / 2, hidden: dir !== "iso" }] })} />

        {selView && (
          <div className="drawing-selection">
            <h2>{viewName(selView.dir)} view</h2>
            {selView.dir !== "iso" && (
              <label className="field check">
                <input type="checkbox" checked={selView.hidden} onChange={(e) => update({ views: sheet.views.map((v) => (v.id === selView.id ? { ...v, hidden: e.target.checked } : v)) })} />
                <span>Hidden lines</span>
              </label>
            )}
            <button className="wide" onClick={removeSelected}>
              Delete view
            </button>
          </div>
        )}
        {selDim && (
          <div className="drawing-selection">
            <h2>Dimension</h2>
            <p>
              <strong>{selDim.dim.kind === "diameter" ? "Ø" : selDim.dim.kind === "radius" ? "R" : ""}{formatValue(selDim.value)} mm</strong>
            </p>
            {selDim.detached && <p className="error-msg">The model changed: its points are gone. Delete it or dimension again.</p>}
            <label className="field">
              <span>Type</span>
              <select value={selDim.dim.kind} onChange={(e) => update({ dimensions: sheet.dimensions.map((d) => (d.id === selDim.dim.id ? { ...d, kind: e.target.value as DrawingDimension["kind"] } : d)) })}>
                {(selDim.dim.kind === "diameter" || selDim.dim.kind === "radius"
                  ? [
                      ["diameter", "Diameter"],
                      ["radius", "Radius"],
                    ]
                  : [
                      ["horizontal", "Horizontal"],
                      ["vertical", "Vertical"],
                      ["aligned", "Aligned"],
                    ]
                ).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <button className="wide" onClick={removeSelected}>
              Delete dimension
            </button>
          </div>
        )}

        <h2 className="drawing-export-title">Export</h2>
        <div className="drawing-export">
          <button onClick={() => exportSheet("pdf")}>PDF</button>
          <button onClick={() => exportSheet("svg")}>SVG</button>
          <button onClick={() => exportSheet("dxf")}>DXF</button>
        </div>
        <p className="muted">Drag views to move them. Dimension (D): click two points or a circle. Wheel zooms, right-drag pans. Views follow the model.</p>
      </aside>
    </>
  );
}

function TextField({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="field">
      <span>{label}</span>
      <input value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onCommit(text)} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
    </label>
  );
}

function AddView({ onAdd }: { onAdd: (dir: ViewDir) => void }) {
  return (
    <label className="field">
      <span>Add view</span>
      <select value="" onChange={(e) => e.target.value && onAdd(e.target.value as ViewDir)}>
        <option value="">Choose…</option>
        {ALL_DIRS.map((d) => (
          <option key={d} value={d}>
            {viewName(d)}
          </option>
        ))}
      </select>
    </label>
  );
}
