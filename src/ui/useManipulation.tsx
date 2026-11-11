// Direct manipulation on the model: selection, drag handles with live preview,
// and a contextual menu / value box that floats next to the selection.
//
// Dragging creates (or adjusts) a regular history feature, so everything stays
// parametric and undoable: the handle is just a faster way to set a number.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import * as THREE from "three";
import type { Scope } from "../expr/expr";
import { makeEdgeTreatment, makePushPull, makeShell, newId, updateFeature } from "../model/doc";
import type { Vec3 } from "../model/frame";
import type { BodyId, Document, EdgeTreatmentFeature, Feature, MeshData, PushPullFeature, TransformFeature } from "../model/types";
import { bodyBounds, edgeAnchor, edgeFrame, faceAnchor } from "../viewport/meshGeom";
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
  /** Handle direction at drag start (the face it was on may be replaced by the preview). */
  dir: Vec3;
  /** Mesh shown when the drag started: source for client-side previews. */
  startMesh: MeshData;
  /** Transform value at drag start, to compute the rigid delta. */
  startTransform?: TransformFeature;
  /** Edge whose radius a "refillet" drag changes. */
  edge?: string;
}

export interface RigidPreview {
  body: BodyId;
  /** Column-major 4x4, applied to the body's current mesh. */
  matrix: number[];
}

export interface GhostPreview {
  mesh: MeshData;
  face: string;
  distance: number;
}

/** World matrix of a transform feature: rotate about the pivot, then translate. */
export function transformMatrix(t: TransformFeature): THREE.Matrix4 {
  const axis = new THREE.Vector3(t.axis === "X" ? 1 : 0, t.axis === "Y" ? 1 : 0, t.axis === "Z" ? 1 : 0);
  const pivot = new THREE.Vector3(t.pivotX, t.pivotY, t.pivotZ);
  return new THREE.Matrix4()
    .makeTranslation(t.dx, t.dy, t.dz)
    .multiply(new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z))
    .multiply(new THREE.Matrix4().makeRotationAxis(axis, (t.angle * Math.PI) / 180))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
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
  // Blend faces are numbered by position ("…]#2"); after a radius change the number can
  // move, so a selected blend is matched again by its edge.
  const relocate = (n: string) => {
    if (faceIndex.has(n)) return n;
    const base = n.replace(/\]#\d+$/, "]");
    if (base === n && !/:blend:/.test(n)) return null;
    return mesh?.faceNames.find((x) => x.replace(/\]#\d+$/, "]") === base) ?? null;
  };
  const live: Selection = {
    faces: selection.faces.map(relocate).filter((n): n is string => !!n),
    edges: selection.edges.filter((n) => edgeSet.has(n)),
    body: selection.body && mesh?.faceBody.includes(selection.body) ? selection.body : null,
  };
  const planar = (n: string) => !!mesh && mesh.facePlanar[faceIndex.get(n) ?? -1];
  const singlePlanarFace = live.faces.length === 1 && planar(live.faces[0]) ? live.faces[0] : null;

  // A selected fillet/chamfer face: its feature and the edge it rounds.
  const blend = useMemo(() => {
    if (live.faces.length !== 1) return null;
    const m = /^((?:fi|ch)-[^:]+):blend:(.+)$/.exec(live.faces[0]);
    if (!m) return null;
    const feature = doc.features.find((f): f is EdgeTreatmentFeature => f.id === m[1] && (f.type === "fillet" || f.type === "chamfer"));
    if (!feature) return null;
    // "#k" after the edge name numbers blend faces by position and can change when the
    // radius does: key overrides by the edge without it (the kernel accepts both).
    const raw = m[2];
    const stripped = raw.replace(/\]#\d+$/, "]");
    const edge = feature.overrides && raw in feature.overrides ? raw : stripped;
    return { feature, edge, face: live.faces[0] };
  }, [live.faces.join(","), doc]);

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

  // Moving/rotating a body is previewed in the viewport (no kernel round trip).
  const rigid = useMemo<RigidPreview | null>(() => {
    if (!drag || drag.feature.type !== "transform") return null;
    const now = transformMatrix(drag.feature);
    const start = transformMatrix(drag.startTransform!);
    return { body: drag.feature.body, matrix: now.multiply(start.invert()).elements.slice() };
  }, [drag]);

  const ghost = useMemo<GhostPreview | null>(() => {
    if (!drag || drag.handle !== "pushpull" || drag.value === 0) return null;
    const f = drag.feature as PushPullFeature;
    return { mesh: drag.startMesh, face: drag.isNew ? f.face : `${f.id}:end`, distance: drag.value };
  }, [drag]);

  const handles = useMemo<Handle[]>(() => {
    if (!enabled || !mesh) return [];
    if (drag) return dragHandles(drag, rigid);
    if (activePushPull) {
      const a = faceAnchor(mesh, `${activePushPull.id}:end`);
      return a ? [{ id: "pushpull", kind: "arrow", origin: a.p, dir: a.n, color: 0x4f8cff }] : [];
    }
    if (singlePlanarFace) {
      const a = faceAnchor(mesh, singlePlanarFace);
      return a ? [{ id: "pushpull", kind: "arrow", origin: a.p, dir: a.n, color: 0x4f8cff }] : [];
    }
    if (blend) {
      const a = faceAnchor(mesh, blend.face);
      const dir = blendDirection(mesh, blend.edge, a?.n);
      return a && dir ? [{ id: "refillet", kind: "arrow", origin: a.p, dir, color: 0xff6b93 }] : [];
    }
    if (live.edges.length) {
      // Only sharp edges get a handle: a smooth (tangent) edge has nothing to round.
      const a = edgeAnchor(mesh, live.edges[0]);
      const fr = edgeFrame(mesh, live.edges[0]);
      return a && fr ? [{ id: "fillet", kind: "arrow", origin: a.p, dir: fr.outward, color: 0xff6b93 }] : [];
    }
    if (live.body) {
      const b = bodyBounds(mesh, live.body);
      return b ? bodyGizmo(b.center) : [];
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, mesh, drag?.handle, rigid, activePushPull?.id, singlePlanarFace, blend?.face, live.edges.join(","), live.body]);

  const onHandleDrag = (id: string, raw: number, phase: DragPhase) => {
    if (!mesh) return;
    if (phase === "start") return setDrag(startDrag(id));
    if (!drag) return;
    if (phase === "move") {
      // Fillets grow slower than the pointer (half the travel, 0.5 mm steps) for finer control.
      // Fillet handles slide on a face: the travel is the radius (0.5 mm steps).
      const value = id === "rotate" ? snap(raw, 5) : id === "fillet" || id === "refillet" ? snap(raw, 0.5) : snap(raw, 1);
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
    if (d.handle === "refillet") return; // keep the blend face selected; its box edits this edge
    setActiveId(f.id);
    if (f.type === "pushpull") setSelection({ faces: [`${f.id}:end`], edges: [], body: null });
    else if (f.type === "fillet" || f.type === "chamfer") setSelection(EMPTY);
  };

  function startDrag(id: string): Drag | null {
    if (!mesh) return null;
    if (id === "pushpull") {
      if (activePushPull) {
        const a = faceAnchor(mesh, `${activePushPull.id}:end`)!;
        return { handle: id, feature: activePushPull, isNew: false, base: activePushPull.distance, value: 0, anchor: a.p, dir: a.n, startMesh: mesh };
      }
      const a = faceAnchor(mesh, singlePlanarFace!)!;
      return { handle: id, feature: makePushPull(doc, singlePlanarFace!, 0), isNew: true, base: 0, value: 0, anchor: a.p, dir: a.n, startMesh: mesh };
    }
    if (id === "refillet" && blend) {
      const a = faceAnchor(mesh, blend.face)!;
      const f = blend.feature;
      const dir = blendDirection(mesh, blend.edge, a.n) ?? [-a.n[0], -a.n[1], -a.n[2]];
      return { handle: id, feature: f, isNew: false, base: overrideFor(f, blend.edge) ?? f.size, value: 0, anchor: a.p, dir, startMesh: mesh, edge: blend.edge };
    }
    if (id === "fillet") {
      const a = edgeAnchor(mesh, live.edges[0])!;
      const fr = edgeFrame(mesh, live.edges[0]);
      const f: EdgeTreatmentFeature = { ...makeEdgeTreatment(doc, "fillet"), edges: live.edges.filter((e) => edgeFrame(mesh, e)), size: 0 };
      return { handle: id, feature: f, isNew: true, base: 0, value: 0, anchor: a.p, dir: fr!.outward, startMesh: mesh };
    }
    // Body gizmo: keep adjusting the transform we just made for this body.
    const b = bodyBounds(mesh, live.body!)!;
    const t: TransformFeature =
      activeTransform && activeTransform.body === live.body
        ? activeTransform
        : { type: "transform", id: newId("tr"), name: `Move ${bodyName(live.body!)}`, suppressed: false, body: live.body!, dx: 0, dy: 0, dz: 0, axis: "Z", angle: 0, pivotX: b.center[0], pivotY: b.center[1], pivotZ: b.center[2] };
    const isNew = t !== activeTransform;
    const base = id === "move-x" ? t.dx : id === "move-y" ? t.dy : id === "move-z" ? t.dz : t.angle;
    return { handle: id, feature: t, isNew, base, value: 0, anchor: b.center, dir: [0, 0, 1], startMesh: mesh, startTransform: t };
  }

  function applyValue(d: Drag, value: number): Feature {
    const v = d.base + value;
    const f = d.feature;
    switch (d.handle) {
      case "pushpull":
        return { ...(f as PushPullFeature), distance: v, exprs: undefined };
      case "fillet":
        return { ...(f as EdgeTreatmentFeature), size: Math.max(0.1, v), exprs: undefined };
      case "refillet": {
        const t = f as EdgeTreatmentFeature;
        const edge = blendEdge(d);
        return { ...t, overrides: { ...withoutVariants(t.overrides, edge), [edge]: Math.max(0.1, v) } };
      }
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
    if (f.type === "transform") return null; // previewed in the viewport
    if ((f.type === "pushpull" && f.distance === 0) || ((f.type === "fillet" || f.type === "chamfer") && f.size <= 0)) return null;
    return drag.isNew ? { ...doc, features: [...doc.features, f] } : updateFeature(doc, f.id, f);
  }, [drag, doc]);

  // ---- floating overlay ------------------------------------------------------------
  const overlay = useMemo<Overlay | null>(() => {
    if (!enabled || !mesh) return null;
    if (drag) {
      const h = dragHandles(drag, rigid)[0];
      const anchor = h ? (h.kind === "arrow" ? h.origin : h.center) : drag.anchor;
      return { anchor, content: <div className="ov-value live">{formatDrag(drag)}</div> };
    }

    if (active) {
      const anchor = activeAnchor(active, mesh);
      if (!anchor) return null;
      return { anchor, content: <ActiveEditor feature={active} scope={scope} doc={doc} commit={commit} onDone={clear} /> };
    }

    const buttons: ReactNode[] = [];
    let anchor: Vec3 | null = null;
    if (blend) {
      anchor = faceAnchor(mesh, blend.face)?.p ?? null;
      const f = blend.feature;
      const current = overrideFor(f, blend.edge);
      const setOverride = (v: number | undefined) => {
        const overrides = withoutVariants(f.overrides, blend.edge);
        if (v !== undefined) overrides[blend.edge] = v;
        commit(updateFeature(doc, f.id, { overrides } as Partial<Feature>));
      };
      buttons.push(<strong key="t" className="ov-title">{f.name} · this edge</strong>);
      buttons.push(
        <label key="v" className="ov-field">
          <span>{f.type === "fillet" ? "R" : "D"}</span>
          <ExprInput value={current ?? f.size} scope={scope} min={0.01} onCommit={({ value }) => setOverride(value)} />
        </label>,
      );
      if (current !== undefined) buttons.push(<button key="r" onClick={() => setOverride(undefined)} title={`Back to ${f.size} like the other edges`}>Reset</button>);
      buttons.push(<span key="h" className="ov-hint">drag the arrow</span>);
    } else if (live.faces.length) {
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
    } else if (live.edges.length && !live.edges.some((e) => edgeFrame(mesh, e))) {
      anchor = edgeAnchor(mesh, live.edges[0])?.p ?? null;
      buttons.push(<span key="s" className="ov-hint">smooth edge · nothing to fillet here</span>);
    } else if (live.edges.length) {
      anchor = edgeAnchor(mesh, live.edges[0])?.p ?? null;
      for (const type of ["fillet", "chamfer"] as const) {
        buttons.push(
          <button
            key={type}
            onClick={() => {
              const f = { ...makeEdgeTreatment(doc, type), edges: live.edges.filter((e) => edgeFrame(mesh, e)), size: 2 };
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
  }, [enabled, mesh, drag, rigid, active, blend, live.faces.join(","), live.edges.join(","), live.body, singlePlanarFace, doc, scope]);

  return { selection: live, pickFace, pickEdge, pickBody, clear, handles, onHandleDrag, overlay, previewDoc, rigid, ghost, singlePlanarFace, activeId };
}

const blendEdge = (d: Drag) => d.edge ?? "";

/** Same edge, ignoring a trailing "#k" added to blend face names. */
const sameEdge = (a: string, b: string) => a.replace(/\]#\d+$/, "]") === b.replace(/\]#\d+$/, "]");

function overrideFor(f: EdgeTreatmentFeature, edge: string): number | undefined {
  if (!f.overrides) return undefined;
  if (edge in f.overrides) return f.overrides[edge];
  const k = Object.keys(f.overrides).find((x) => sameEdge(x, edge));
  return k ? f.overrides[k] : undefined;
}

/** Overrides without any key that refers to `edge`. */
function withoutVariants(o: Record<string, number> | undefined, edge: string): Record<string, number> {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !sameEdge(k, edge)));
}

/**
 * Handle direction on a fillet face: straight out of the solid (the face's
 * outward normal, perpendicular to the rounded edge). Dragging along it grows the radius.
 */
function blendDirection(_mesh: MeshData, _edge: string, blendNormal?: Vec3): Vec3 | null {
  return blendNormal ?? null;
}



const toggle = (list: string[], x: string) => (list.includes(x) ? list.filter((n) => n !== x) : [...list, x]);

function dragHandles(d: Drag, rigid: RigidPreview | null): Handle[] {
  if (d.handle === "pushpull" || d.handle === "fillet" || d.handle === "refillet") {
    // The grabbed arrow follows the value along its direction.
    const k = d.value;
    const origin: Vec3 = [d.anchor[0] + d.dir[0] * k, d.anchor[1] + d.dir[1] * k, d.anchor[2] + d.dir[2] * k];
    return [{ id: d.handle, kind: "arrow", origin, dir: d.dir, color: 0xffc53d }];
  }
  // Body gizmo moves with the body.
  const c = new THREE.Vector3(...d.anchor);
  if (rigid) c.applyMatrix4(new THREE.Matrix4().fromArray(rigid.matrix));
  return bodyGizmo([c.x, c.y, c.z]).map((h) => (h.id === d.handle ? { ...h, color: 0xffc53d } : h));
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
    case "refillet":
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
