// Direct manipulation on the model: selection, drag handles with live preview,
// and a contextual menu / value box that floats next to the selection.
//
// Dragging creates (or adjusts) a regular history feature, so everything stays
// parametric and undoable: the handle is just a faster way to set a number.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Scope } from "../expr/expr";
import { makeEdgeTreatment, makePushPull, makeShell, newId, updateFeature } from "../model/doc";
import type { Vec3 } from "../model/frame";
import type { BodyId, Document, EdgeTreatmentFeature, Feature, MeshData, PushPullFeature, TransformFeature } from "../model/types";
import { bodyBounds, edgeAnchor, faceAnchor } from "../viewport/meshGeom";
import type { DragPhase, Handle, Overlay } from "../viewport/Viewport";
import { ExprInput } from "./ExprInput";

export interface Selection {
  faces: string[];
  edges: string[];
  body: BodyId | null;
}

const EMPTY: Selection = { faces: [], edges: [], body: null };

interface Params {
  doc: Document;
  mesh: MeshData | null;
  scope: Scope;
  /** Manipulation is off while a sketch or a topology-picking feature is being edited. */
  enabled: boolean;
  commit: (next: Document) => void;
  onSketchOnFace: (face: string) => void;
  onAddFeature: (f: Feature) => void;
  bodyName: (id: BodyId) => string;
}

interface Drag {
  handle: string;
  /** Feature being created or adjusted. */
  feature: Feature;
  /** Whether `feature` is new (appended) or replaces an existing one. */
  isNew: boolean;
  base: number;
  value: number;
  anchor: Vec3;
}

/** 1 mm steps, 5° for rotations. */
const snap = (v: number, step: number) => Math.round(v / step) * step;

export function useManipulation({ doc, mesh, scope, enabled, commit, onSketchOnFace, onAddFeature, bodyName }: Params) {
  const [selection, setSelection] = useState<Selection>(EMPTY);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  const active = doc.features.find((f) => f.id === activeId) ?? null;
  const clear = useCallback(() => {
    setSelection(EMPTY);
    setActiveId(null);
  }, []);

  // Selection entries that no longer exist in the mesh are ignored.
  const faceIndex = useMemo(() => new Map((mesh?.faceNames ?? []).map((n, i) => [n, i])), [mesh]);
  const edgeSet = useMemo(() => new Set(mesh?.edgeNames ?? []), [mesh]);
  const live: Selection = {
    faces: selection.faces.filter((n) => faceIndex.has(n)),
    edges: selection.edges.filter((n) => edgeSet.has(n)),
    body: selection.body && mesh?.faceBody.includes(selection.body) ? selection.body : null,
  };
  const planar = (n: string) => !!mesh && mesh.facePlanar[faceIndex.get(n) ?? -1];
  const singlePlanarFace = live.faces.length === 1 && planar(live.faces[0]) ? live.faces[0] : null;

  useEffect(() => {
    if (!enabled) {
      setSelection(EMPTY);
      setActiveId(null);
    }
  }, [enabled]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (e.target as HTMLElement).tagName !== "INPUT") clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clear]);

  // ---- picking -------------------------------------------------------------------
  const pickFace = (name: string | null, additive: boolean) => {
    setActiveId(null);
    if (!name) return setSelection(EMPTY);
    setSelection((s) => {
      const faces = additive ? (s.faces.includes(name) ? s.faces.filter((n) => n !== name) : [...s.faces, name]) : s.faces.length === 1 && s.faces[0] === name ? [] : [name];
      return { faces, edges: additive ? s.edges : [], body: null };
    });
  };
  /** Edges accumulate: each click adds or removes one (like picking edges for a fillet). */
  const pickEdge = (name: string, additive: boolean) => {
    setActiveId(null);
    setSelection((s) => ({ faces: additive ? s.faces : [], edges: toggle(s.edges, name), body: null }));
  };
  const pickBody = (id: BodyId) => {
    setActiveId(null);
    setSelection({ faces: [], edges: [], body: id });
  };

  // ---- handles -------------------------------------------------------------------
  const activePushPull = active?.type === "pushpull" ? active : null;
  const activeTransform = active?.type === "transform" ? active : null;

  const handles = useMemo<Handle[]>(() => {
    if (!enabled || !mesh) return [];
    if (drag) return dragHandles(drag, mesh);
    if (activePushPull) {
      const a = faceAnchor(mesh, `${activePushPull.id}:end`);
      return a ? [{ id: "pushpull", kind: "arrow", origin: a.p, dir: a.n, color: 0x4f8cff }] : [];
    }
    if (singlePlanarFace) {
      const a = faceAnchor(mesh, singlePlanarFace);
      return a ? [{ id: "pushpull", kind: "arrow", origin: a.p, dir: a.n, color: 0x4f8cff }] : [];
    }
    if (live.edges.length) {
      const a = edgeAnchor(mesh, live.edges[0]);
      return a ? [{ id: "fillet", kind: "arrow", origin: a.p, dir: a.inward, color: 0xff6b93 }] : [];
    }
    if (live.body) {
      const b = bodyBounds(mesh, live.body);
      return b ? bodyGizmo(b.center) : [];
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, mesh, drag?.handle, activePushPull?.id, singlePlanarFace, live.edges.join(","), live.body]);

  const onHandleDrag = (id: string, raw: number, phase: DragPhase) => {
    if (!mesh) return;
    if (phase === "start") return setDrag(startDrag(id));
    if (!drag) return;
    if (phase === "move") {
      // Fillets grow slower than the pointer (half the travel, 0.5 mm steps) for finer control.
      const value = id === "rotate" ? snap(raw, 5) : id === "fillet" ? snap(raw / 2, 0.5) : snap(raw, 1);
      if (value === drag.value) return;
      setDrag({ ...drag, value, feature: applyValue(drag, value) });
      return;
    }
    // end
    const d = drag;
    setDrag(null);
    if (d.value === 0 && d.isNew) return; // a click on the handle, nothing to do
    const f = applyValue(d, d.value);
    commit(d.isNew ? { ...doc, features: [...doc.features, f] } : updateFeature(doc, f.id, f));
    setActiveId(f.id);
    if (f.type === "pushpull") setSelection({ faces: [`${f.id}:end`], edges: [], body: null });
    else if (f.type === "fillet" || f.type === "chamfer") setSelection(EMPTY);
  };

  function startDrag(id: string): Drag | null {
    if (!mesh) return null;
    if (id === "pushpull") {
      if (activePushPull) {
        const a = faceAnchor(mesh, `${activePushPull.id}:end`)!;
        return { handle: id, feature: activePushPull, isNew: false, base: activePushPull.distance, value: 0, anchor: a.p };
      }
      const a = faceAnchor(mesh, singlePlanarFace!)!;
      return { handle: id, feature: makePushPull(doc, singlePlanarFace!, 0), isNew: true, base: 0, value: 0, anchor: a.p };
    }
    if (id === "fillet") {
      const a = edgeAnchor(mesh, live.edges[0])!;
      const f: EdgeTreatmentFeature = { ...makeEdgeTreatment(doc, "fillet"), edges: live.edges, size: 0 };
      return { handle: id, feature: f, isNew: true, base: 0, value: 0, anchor: a.p };
    }
    // Body gizmo: keep adjusting the transform we just made for this body.
    const b = bodyBounds(mesh, live.body!)!;
    const t: TransformFeature =
      activeTransform && activeTransform.body === live.body
        ? activeTransform
        : { type: "transform", id: newId("tr"), name: `Move ${bodyName(live.body!)}`, suppressed: false, body: live.body!, dx: 0, dy: 0, dz: 0, axis: "Z", angle: 0, pivotX: b.center[0], pivotY: b.center[1], pivotZ: b.center[2] };
    const isNew = t !== activeTransform;
    const base = id === "move-x" ? t.dx : id === "move-y" ? t.dy : id === "move-z" ? t.dz : t.angle;
    return { handle: id, feature: t, isNew, base, value: 0, anchor: b.center };
  }

  function applyValue(d: Drag, value: number): Feature {
    const v = d.base + value;
    const f = d.feature;
    switch (d.handle) {
      case "pushpull":
        return { ...(f as PushPullFeature), distance: v, exprs: undefined };
      case "fillet":
        return { ...(f as EdgeTreatmentFeature), size: Math.max(0.1, v), exprs: undefined };
      case "move-x":
        return { ...(f as TransformFeature), dx: v };
      case "move-y":
        return { ...(f as TransformFeature), dy: v };
      case "move-z":
        return { ...(f as TransformFeature), dz: v };
      default:
        return { ...(f as TransformFeature), angle: ((v + 540) % 360) - 180 };
    }
  }

  // While dragging, the kernel previews the document with the feature applied.
  const previewDoc = useMemo<Document | null>(() => {
    if (!drag || (drag.value === 0 && drag.isNew)) return null;
    const f = drag.feature;
    if ((f.type === "pushpull" && f.distance === 0) || ((f.type === "fillet" || f.type === "chamfer") && f.size <= 0)) return null;
    return drag.isNew ? { ...doc, features: [...doc.features, f] } : updateFeature(doc, f.id, f);
  }, [drag, doc]);

  // ---- floating overlay ------------------------------------------------------------
  const overlay = useMemo<Overlay | null>(() => {
    if (!enabled || !mesh) return null;
    if (drag) return { anchor: drag.anchor, content: <div className="ov-value live">{formatDrag(drag)}</div> };

    if (active) {
      const anchor = activeAnchor(active, mesh);
      if (!anchor) return null;
      return { anchor, content: <ActiveEditor feature={active} scope={scope} doc={doc} commit={commit} onDone={clear} /> };
    }

    const buttons: ReactNode[] = [];
    let anchor: Vec3 | null = null;
    if (live.faces.length) {
      anchor = faceAnchor(mesh, live.faces[0])?.p ?? null;
      if (singlePlanarFace) {
        buttons.push(<button key="sk" onClick={() => onSketchOnFace(singlePlanarFace)}>✎ Sketch</button>);
        buttons.push(<span key="hint" className="ov-hint">drag the arrow to push/pull</span>);
      }
      buttons.push(
        <button key="sh" onClick={() => (onAddFeature(makeShell(doc, live.faces)), clear())}>
          ▢ Shell
        </button>,
      );
    } else if (live.edges.length) {
      anchor = edgeAnchor(mesh, live.edges[0])?.p ?? null;
      for (const type of ["fillet", "chamfer"] as const) {
        buttons.push(
          <button
            key={type}
            onClick={() => {
              const f = { ...makeEdgeTreatment(doc, type), edges: live.edges, size: 2 };
              commit({ ...doc, features: [...doc.features, f] });
              setActiveId(f.id);
              setSelection(EMPTY);
            }}
          >
            {type === "fillet" ? "◜ Fillet" : "◸ Chamfer"}
          </button>,
        );
      }
      buttons.push(<span key="n" className="ov-hint">{live.edges.length} edge{live.edges.length > 1 ? "s" : ""} · drag the arrow</span>);
    } else if (live.body) {
      anchor = bodyBounds(mesh, live.body)?.center ?? null;
      buttons.push(<span key="b" className="ov-hint">{bodyName(live.body)} · drag arrows to move, ring to rotate</span>);
    }
    return anchor && buttons.length ? { anchor, content: <div className="ov-menu">{buttons}</div> } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, mesh, drag, active, live.faces.join(","), live.edges.join(","), live.body, singlePlanarFace, doc, scope]);

  return { selection: live, pickFace, pickEdge, pickBody, clear, handles, onHandleDrag, overlay, previewDoc, singlePlanarFace, activeId };
}

const toggle = (list: string[], x: string) => (list.includes(x) ? list.filter((n) => n !== x) : [...list, x]);

function dragHandles(d: Drag, mesh: MeshData): Handle[] {
  // Keep showing the grabbed handle at its start position while previewing.
  if (d.handle === "pushpull" || d.handle === "fillet") {
    const f = d.feature;
    const dir = f.type === "pushpull" ? faceAnchor(mesh, f.face)?.n : undefined;
    return dir ? [{ id: d.handle, kind: "arrow", origin: d.anchor, dir, color: 0xffc53d }] : [];
  }
  return [];
}

function bodyGizmo(c: Vec3): Handle[] {
  return [
    { id: "move-x", kind: "arrow", origin: c, dir: [1, 0, 0], color: 0xe5484d },
    { id: "move-y", kind: "arrow", origin: c, dir: [0, 1, 0], color: 0x30a46c },
    { id: "move-z", kind: "arrow", origin: c, dir: [0, 0, 1], color: 0x3e63dd },
    { id: "rotate", kind: "ring", center: c, axis: [0, 0, 1], color: 0x8e6cf0 },
  ];
}

function formatDrag(d: Drag): string {
  const v = d.base + d.value;
  switch (d.handle) {
    case "pushpull":
      return `${v > 0 ? "+" : ""}${v} mm`;
    case "fillet":
      return `R ${Math.max(0.1, v)} mm`;
    case "rotate":
      return `${(((v + 540) % 360) - 180).toFixed(0)}°`;
    default:
      return `${d.handle.slice(-1).toUpperCase()} ${v > 0 ? "+" : ""}${v} mm`;
  }
}

function activeAnchor(f: Feature, mesh: MeshData): Vec3 | null {
  if (f.type === "pushpull") return faceAnchor(mesh, `${f.id}:end`)?.p ?? faceAnchor(mesh, f.face)?.p ?? null;
  if (f.type === "fillet" || f.type === "chamfer") {
    const blend = mesh.faceNames.find((n) => n.startsWith(`${f.id}:blend:`));
    return blend ? faceAnchor(mesh, blend)?.p ?? null : null;
  }
  if (f.type === "transform") return bodyBounds(mesh, f.body)?.center ?? null;
  return null;
}

/** Value box for the feature just created by a drag or a menu button. */
function ActiveEditor({ feature: f, scope, doc, commit, onDone }: { feature: Feature; scope: Scope; doc: Document; commit: (d: Document) => void; onDone: () => void }) {
  const set = (patch: Partial<Feature>) => commit(updateFeature(doc, f.id, patch));
  const field = (key: string, label: string, min?: number) => {
    const value = (f as unknown as Record<string, number>)[key];
    return (
      <label className="ov-field" key={key}>
        <span>{label}</span>
        <ExprInput
          value={value}
          expr={f.exprs?.[key]}
          scope={scope}
          min={min}
          onCommit={({ value: v, expr }) => {
            const exprs = { ...f.exprs };
            if (expr) exprs[key] = expr;
            else delete exprs[key];
            set({ [key]: v, exprs } as Partial<Feature>);
          }}
        />
      </label>
    );
  };
  return (
    <div className="ov-menu">
      <strong className="ov-title">{f.name}</strong>
      {f.type === "pushpull" && field("distance", "Distance")}
      {(f.type === "fillet" || f.type === "chamfer") && (
        <>
          {field("size", f.type === "fillet" ? "Radius" : "Distance", 0.01)}
          <button onClick={() => set({ type: f.type === "fillet" ? "chamfer" : "fillet", name: f.name.replace(/^(Fillet|Chamfer)/, f.type === "fillet" ? "Chamfer" : "Fillet") } as Partial<Feature>)}>
            {f.type === "fillet" ? "◸ Chamfer" : "◜ Fillet"}
          </button>
        </>
      )}
      {f.type === "transform" && (
        <>
          {field("dx", "X")}
          {field("dy", "Y")}
          {field("dz", "Z")}
          {field("angle", "Rotate °")}
        </>
      )}
      <button className="primary" onClick={onDone} title="Done (Esc)">
        ✓
      </button>
    </div>
  );
}
