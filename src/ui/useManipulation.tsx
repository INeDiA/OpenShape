// Direct manipulation on the model: selection, drag handles with live preview,
// and a contextual menu / value box that floats next to the selection.
//
// Dragging creates (or adjusts) a regular history feature, so everything stays
// parametric and undoable: the handle is just a faster way to set a number.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import * as THREE from "three";
import type { Scope } from "../expr/expr";
import { makeCove, makeEdgeTreatment, makeExtrude, makePushPull, makeRevolve, makeShell, newId, updateFeature } from "../model/doc";
import type { Vec3 } from "../model/frame";
import type { BodyId, BooleanOp, CoveFeature, Document, EdgeTreatmentFeature, ExtrudeFeature, Feature, MeshData, PushPullFeature, RevolveFeature, SketchFeature, SketchPreview, TransformFeature } from "../model/types";
import { entityMap, pointOf, sketchLines } from "../sketch/model";
import { bodyBounds, bodyContaining, covePreview, edgeAnchor, edgeFrame, faceAnchor, filletPreview, refilletPreview } from "../viewport/meshGeom";
import { extrudeSweep, revolveSweep } from "../viewport/sweep";
import type { DragPhase, Handle, Overlay } from "../viewport/Viewport";
import { ExprInput } from "./ExprInput";
import { Icon } from "./icons";
import type { Command } from "./ToolMenus";

export interface Selection {
  faces: string[];
  edges: string[];
  body: BodyId | null;
  /** Sketch regions, all from one sketch. */
  regions: { sketch: string; id: string }[];
}

const EMPTY: Selection = { faces: [], edges: [], body: null, regions: [] };

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
  /**
   * More actions offered next to a selection of faces, edges or a body (the
   * toolbar's commands). A getter, read again on click so the action uses the latest document.
   */
  contextActions?: () => ContextActions;
  /** Sketch previews from the kernel: frames and regions for region extrusion. */
  sketches: SketchPreview[];
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
  /** The blend face being re-rounded (hidden while its preview is shown). */
  blendFace?: string;
  /** For a new region extrusion: the point on the sketch plane the operation is judged from. */
  regionBase?: Vec3;
}

/**
 * Commands offered next to a selection: one planar face, several faces, edges,
 * a body. Shown whenever that kind of selection is made; whether a command can
 * run is checked again on click, with the latest document.
 */
export interface ContextActions {
  face?: Command[];
  /** Cylindrical faces only (holes). */
  cylinder?: Command[];
  faces?: Command[];
  edge?: Command[];
  body?: Command[];
}

/** A line the revolve axis can be: a sketch line or a world axis. */
export interface AxisCandidate {
  id: string;
  label: string;
  a: Vec3;
  b: Vec3;
  world: boolean;
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

export function useManipulation({ doc, mesh, scope, enabled, commit, onSketchOnFace, onAddFeature, bodyName, sketches, contextActions }: Params) {
  const [selection, setSelection] = useState<Selection>(EMPTY);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  const active = doc.features.find((f) => f.id === activeId) ?? null;
  /** Revolve waiting for its axis: nothing is created until one is picked. */
  const [axisPick, setAxisPick] = useState<{ sketch: string; regions?: string[] } | null>(null);
  /** Revolve with its axis chosen, waiting for an angle (dragged or typed); not in the document yet. */
  const [pendingRevolve, setPendingRevolve] = useState<RevolveFeature | null>(null);
  const clear = useCallback(() => {
    setSelection(EMPTY);
    setActiveId(null);
    setAxisPick(null);
    setPendingRevolve(null);
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
    regions: selection.regions.filter((r) => sketches.some((sk) => sk.id === r.sketch && sk.regions.some((x) => x.id === r.id))),
  };
  // Where the arrow for extruding the selected regions sits: inside the first region, along the plane normal.
  const regionSpot = useMemo(() => {
    const first = live.regions[0];
    if (!first) return null;
    const sk = sketches.find((x) => x.id === first.sketch)!;
    const r = sk.regions.find((x) => x.id === first.id)!;
    return { sketch: sk, p: onPlane(sk, r.inside), n: sk.frame.n };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.regions.map((r) => r.sketch + "/" + r.id).join(","), sketches]);
  const planar = (n: string) => !!mesh && mesh.facePlanar[faceIndex.get(n) ?? -1];
  const singlePlanarFace = live.faces.length === 1 && planar(live.faces[0]) ? live.faces[0] : null;

  // A selected fillet/chamfer face: its feature and the edge it rounds.
  // A selected cove groove face: its feature (radius box and arrow, like a fillet face).
  const coveSel = useMemo(() => {
    if (live.faces.length !== 1) return null;
    const m = /^(cv-[^:]+):cove:/.exec(live.faces[0]);
    if (!m) return null;
    const feature = doc.features.find((f): f is CoveFeature => f.id === m[1] && f.type === "cove");
    return feature ? { feature, face: live.faces[0] } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.faces.join(","), doc]);

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
      return { faces, edges: additive ? s.edges : [], body: null, regions: [] };
    });
  };
  /** Regions accumulate with Shift/Cmd inside one sketch; a region of another sketch starts over. */
  const pickRegion = (sketch: string, id: string, additive: boolean) => {
    setActiveId(null);
    setSelection((s) => {
      const same = s.regions.length && s.regions[0].sketch === sketch;
      const has = s.regions.some((r) => r.sketch === sketch && r.id === id);
      const regions = additive && same ? (has ? s.regions.filter((r) => r.id !== id) : [...s.regions, { sketch, id }]) : has && s.regions.length === 1 ? [] : [{ sketch, id }];
      return { ...EMPTY, regions };
    });
  };
  /** Edges accumulate: each click adds or removes one (like picking edges for a fillet). */
  const pickEdge = (name: string, additive: boolean) => {
    setActiveId(null);
    setSelection((s) => ({ faces: additive ? s.faces : [], edges: toggle(s.edges, name), body: null, regions: [] }));
  };
  const pickBody = (id: BodyId) => {
    setActiveId(null);
    setSelection({ ...EMPTY, body: id });
  };

  // ---- handles -------------------------------------------------------------------
  const activePushPull = active?.type === "pushpull" ? active : null;
  const activeExtrude = active?.type === "extrude" ? active : null;
  const activeRevolve = active?.type === "revolve" ? active : null;
  const activeCove = active?.type === "cove" ? active : null;
  /** Groove faces of a cove in the shown mesh, and the arrow to change its radius (out of the groove). */
  const coveFaces = (f: CoveFeature) => (mesh?.faceNames ?? []).filter((n) => n.startsWith(`${f.id}:cove:`));
  const coveSpot = (f: CoveFeature) => {
    if (!mesh) return null;
    const face = coveFaces(f)[0];
    return face ? faceAnchor(mesh, face) : null;
  };
  /** Ring for a revolve: around its axis, level with its (first) region. */
  const revolveRing = (f: RevolveFeature) => {
    const sk = sketches.find((x) => x.id === f.sketchId);
    if (!sk) return null;
    const axis = revolveAxis(doc, f, sk);
    if (!axis) return null;
    const r = sk.regions.find((x) => x.id === f.regions?.[0]) ?? sk.regions[0];
    const p = r ? onPlane(sk, r.inside) : axis.origin;
    // Foot of the perpendicular from the region onto the axis.
    const w = [p[0] - axis.origin[0], p[1] - axis.origin[1], p[2] - axis.origin[2]];
    const t = w[0] * axis.dir[0] + w[1] * axis.dir[1] + w[2] * axis.dir[2];
    const center: Vec3 = [axis.origin[0] + axis.dir[0] * t, axis.origin[1] + axis.dir[1] * t, axis.origin[2] + axis.dir[2] * t];
    // The knob sits on the moving end of the revolution (the profile turned by the angle),
    // so turning it clockwise or counter-clockwise drags that end the same way.
    const end = new THREE.Vector3(p[0] - center[0], p[1] - center[1], p[2] - center[2]).applyAxisAngle(new THREE.Vector3(...axis.dir), (f.angle * Math.PI) / 180);
    return { center, axis: axis.dir, label: axis.label, toward: end.toArray() as Vec3 };
  };
  /** Arrow position for an extrude: its region's inside point moved to the end of the extrusion. */
  const extrudeSpot = (f: ExtrudeFeature, distance = f.distance) => {
    const sk = sketches.find((x) => x.id === f.sketchId);
    // Extrudes of a whole sketch (no regions listed) put the arrow on its first region.
    const r = sk?.regions.find((x) => x.id === f.regions?.[0]) ?? sk?.regions[0];
    if (!sk || !r) return null;
    const p = onPlane(sk, r.inside), n = sk.frame.n;
    return { p: [p[0] + n[0] * distance, p[1] + n[1] * distance, p[2] + n[2] * distance] as Vec3, base: p, n };
  };
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

  // Translucent swept volume while dragging an extrude or revolve of sketch regions (no kernel wait).
  const sweep = useMemo<{ positions: Float32Array; cut: boolean; fillet?: { normals: Float32Array; bands: Float32Array } } | null>(() => {
    if (!drag) return null;
    const f = drag.feature;
    // New fillet: the rounded surface on the chosen edges (and the face bands it eats into),
    // from the mesh shown when the drag started.
    if (drag.handle === "fillet" && f.type === "fillet") {
      const p = filletPreview(drag.startMesh, f.edges, f.size);
      return p.arc.length ? { positions: p.arc, cut: false, fillet: { normals: p.normals, bands: p.bands } } : null;
    }
    // Cove: the new groove on each of its edges (rebuilt from the current groove of radius drag.base).
    if (drag.handle === "cove" && f.type === "cove") {
      const arc: number[] = [], normals: number[] = [], bands: number[] = [];
      for (const edge of f.edges) {
        const faces = drag.startMesh.faceNames.filter((n) => n === `${f.id}:cove:${edge}` || n.startsWith(`${f.id}:cove:${edge}#`));
        const p = covePreview(drag.startMesh, faces, edge, f.size, 8, drag.base);
        if (!p) continue;
        arc.push(...p.arc);
        normals.push(...p.normals);
        bands.push(...p.bands);
      }
      return arc.length ? { positions: new Float32Array(arc), cut: true, fillet: { normals: new Float32Array(normals), bands: new Float32Array(bands) } } : null;
    }
    // Existing fillet face: the same preview, on the sharp edge rebuilt under it.
    if (drag.handle === "refillet" && drag.blendFace && drag.edge) {
      const p = refilletPreview(drag.startMesh, drag.blendFace, drag.edge, Math.max(0.1, drag.base + drag.value));
      return p?.arc.length ? { positions: p.arc, cut: false, fillet: { normals: p.normals, bands: p.bands } } : null;
    }
    if (drag.handle !== "extrude" && drag.handle !== "revolve") return null;
    if (f.type === "extrude" && f.distance !== 0) {
      const sk = sketches.find((x) => x.id === f.sketchId);
      return sk ? { positions: extrudeSweep(sk, f.regions, f.distance), cut: f.op === "cut" } : null;
    }
    if (f.type === "revolve" && f.angle !== 0) {
      const sk = sketches.find((x) => x.id === f.sketchId);
      const axis = sk && revolveAxis(doc, f, sk);
      return sk && axis ? { positions: revolveSweep(sk, f.regions, axis.origin, axis.dir, f.angle), cut: f.op === "cut" } : null;
    }
    return null;
  }, [drag, sketches, doc]);

  // The blend being re-rounded is hidden while its new shape is previewed.
  const hiddenFaces = useMemo(() => {
    if (!drag || !sweep) return [];
    if (drag.handle === "refillet" && drag.blendFace) return [drag.blendFace];
    if (drag.handle === "cove" && drag.feature.type === "cove") return drag.startMesh.faceNames.filter((n) => n.startsWith(`${drag.feature.id}:cove:`));
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.handle, drag?.blendFace, !!sweep]);

  const handles = useMemo<Handle[]>(() => {
    if (!enabled || !mesh || axisPick) return [];
    if (drag) return dragHandles(drag, rigid);
    if (activePushPull) {
      const a = faceAnchor(mesh, `${activePushPull.id}:end`);
      return a ? [{ id: "pushpull", kind: "arrow", origin: a.p, dir: a.n, color: 0x4f8cff }] : [];
    }
    if (activeExtrude) {
      const a = extrudeSpot(activeExtrude);
      return a ? [{ id: "extrude", kind: "arrow", origin: a.p, dir: a.n, color: 0x4f8cff }] : [];
    }
    if (activeCove || coveSel) {
      const a = activeCove ? coveSpot(activeCove) : faceAnchor(mesh, coveSel!.face);
      return a ? [{ id: "cove", kind: "arrow", origin: a.p, dir: a.n, color: 0xff6b93 }] : [];
    }
    if (pendingRevolve || activeRevolve) {
      const ring = revolveRing((pendingRevolve ?? activeRevolve)!);
      return ring ? [{ id: "revolve", kind: "ring", center: ring.center, axis: ring.axis, color: 0x8e6cf0, arc: 120, toward: ring.toward }] : [];
    }
    if (regionSpot) return [{ id: "extrude", kind: "arrow", origin: regionSpot.p, dir: regionSpot.n, color: 0x4f8cff }];
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
  }, [enabled, mesh, drag?.handle, drag?.value, rigid, activePushPull?.id, activeExtrude, activeRevolve, activeCove, coveSel?.face, pendingRevolve, regionSpot, singlePlanarFace, blend?.face, live.edges.join(","), live.body]);

  const onHandleDrag = (id: string, raw: number, phase: DragPhase) => {
    if (!mesh) return;
    if (phase === "start") return setDrag(startDrag(id));
    if (!drag) return;
    if (phase === "move") {
      // Fillets grow slower than the pointer (half the travel, 0.5 mm steps) for finer control.
      // Fillet handles slide on a face: the travel is the radius (0.5 mm steps).
      const value = id === "rotate" || id === "revolve" ? snap(raw, 5) : id === "fillet" || id === "refillet" || id === "cove" ? snap(raw, 0.5) : snap(raw, 1);
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
    if (f.type === "revolve") setPendingRevolve(null);
    if (d.handle === "refillet") return; // keep the blend face selected; its box edits this edge
    setActiveId(f.id);
    if (f.type === "pushpull") setSelection({ ...EMPTY, faces: [`${f.id}:end`] });
    else if (f.type === "extrude") setSelection(EMPTY);
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
    if (id === "cove" && (activeCove || coveSel)) {
      const f = activeCove ?? coveSel!.feature;
      const a = (activeCove ? coveSpot(activeCove) : faceAnchor(mesh, coveSel!.face))!;
      return { handle: id, feature: f, isNew: false, base: f.size, value: 0, anchor: a.p, dir: a.n, startMesh: mesh };
    }
    if (id === "revolve" && pendingRevolve) {
      const ring = revolveRing(pendingRevolve)!;
      return { handle: id, feature: pendingRevolve, isNew: true, base: 0, value: 0, anchor: ring.center, dir: ring.axis, startMesh: mesh };
    }
    if (id === "revolve" && activeRevolve) {
      const ring = revolveRing(activeRevolve)!;
      return { handle: id, feature: activeRevolve, isNew: false, base: activeRevolve.angle, value: 0, anchor: ring.center, dir: ring.axis, startMesh: mesh };
    }
    if (id === "extrude") {
      if (activeExtrude) {
        const a = extrudeSpot(activeExtrude)!;
        return { handle: id, feature: activeExtrude, isNew: false, base: activeExtrude.distance, value: 0, anchor: a.p, dir: a.n, startMesh: mesh };
      }
      const spot = regionSpot!;
      const f: ExtrudeFeature = { ...makeExtrude(doc, spot.sketch.id, "new"), regions: live.regions.map((r) => r.id), distance: 0 };
      return { handle: id, feature: f, isNew: true, base: 0, value: 0, anchor: spot.p, dir: spot.n, startMesh: mesh, regionBase: spot.p };
    }
    if (id === "refillet" && blend) {
      const a = faceAnchor(mesh, blend.face)!;
      const f = blend.feature;
      const dir = blendDirection(mesh, blend.edge, a.n) ?? [-a.n[0], -a.n[1], -a.n[2]];
      return { handle: id, feature: f, isNew: false, base: overrideFor(f, blend.edge) ?? f.size, value: 0, anchor: a.p, dir, startMesh: mesh, edge: blend.edge, blendFace: blend.face };
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
      case "revolve": {
        // Up to a full turn either way; never 0 (that would be no solid).
        let a = Math.max(-360, Math.min(360, v));
        if (Math.abs(a) < 1) a = a < 0 ? -1 : 1;
        return { ...(f as RevolveFeature), angle: a, exprs: undefined };
      }
      case "extrude": {
        const e = f as ExtrudeFeature;
        // New extrusions pick their operation from where they go; existing ones keep theirs.
        // Dragging sets an explicit depth, so it ends "through all".
        if (!d.isNew) return { ...e, distance: v, throughAll: undefined, exprs: undefined };
        const { op, target } = autoOperation(d.startMesh, d.regionBase ?? d.anchor, d.dir, v);
        return { ...e, distance: v, op, target, exprs: undefined };
      }
      case "fillet":
        return { ...(f as EdgeTreatmentFeature), size: Math.max(0.1, v), exprs: undefined };
      case "cove":
        return { ...(f as CoveFeature), size: Math.max(0.1, v), exprs: undefined };
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
  // The solid itself is only rebuilt when the handle is released: while dragging,
  // previews are drawn in the viewport (ghost prism, swept volume, rigid move).
  const dragging = !!drag;

  // ---- revolve axis picking --------------------------------------------------------
  /** Starts a revolve of a sketch (or some of its regions): the axis is picked next. */
  const startRevolve = useCallback((sketch: string, regions?: string[]) => {
    setSelection(EMPTY);
    setActiveId(null);
    setAxisPick({ sketch, regions });
  }, []);

  /** Lines that can be the axis: the sketch's lines, then the world axes through the origin. */
  const axisCandidates = useMemo<AxisCandidate[]>(() => {
    if (!axisPick) return [];
    const sk = sketches.find((x) => x.id === axisPick.sketch);
    const sketch = doc.features.find((f): f is SketchFeature => f.id === axisPick.sketch && f.type === "sketch");
    const out: AxisCandidate[] = [];
    if (sk && sketch) {
      const m = entityMap(sketch.sketch);
      for (const l of sketchLines(sketch.sketch)) {
        const line = m.get(l.id);
        if (!line || line.kind !== "line") continue;
        const a = pointOf(m, line.p1), b = pointOf(m, line.p2);
        out.push({ id: l.id, label: l.label, a: onPlane(sk, [a.x, a.y]), b: onPlane(sk, [b.x, b.y]), world: false });
      }
    }
    let size = 100;
    if (mesh?.vertices.length) {
      for (let i = 0; i < mesh.vertices.length; i++) size = Math.max(size, Math.abs(mesh.vertices[i]) * 1.5);
    }
    for (const [id, d] of [["X", [1, 0, 0]], ["Y", [0, 1, 0]], ["Z", [0, 0, 1]]] as const) {
      out.push({ id, label: `world ${id}`, a: [-d[0] * size, -d[1] * size, -d[2] * size], b: [d[0] * size, d[1] * size, d[2] * size], world: true });
    }
    return out;
  }, [axisPick, sketches, doc, mesh]);

  const pickAxis = (id: string) => {
    if (!axisPick) return;
    const sk = sketches.find((x) => x.id === axisPick.sketch);
    const r = sk?.regions.find((x) => x.id === axisPick.regions?.[0]) ?? sk?.regions[0];
    const { op, target } = sk && r ? autoOperation(mesh, onPlane(sk, r.inside), sk.frame.n, 1) : { op: "new" as BooleanOp, target: undefined };
    const world = id === "X" || id === "Y" || id === "Z";
    // Nothing is built yet: the ring appears and the angle comes from the user.
    const f: RevolveFeature = { ...makeRevolve(doc, axisPick.sketch, op), regions: axisPick.regions, target, angle: 0, ...(world ? { axis: id } : { axisLine: id }) };
    setAxisPick(null);
    setPendingRevolve(f);
  };

  /** Creates the pending revolve with a typed angle. */
  const finishRevolve = (angle: number) => {
    if (!pendingRevolve || !angle) return;
    const f = { ...pendingRevolve, angle: Math.max(-360, Math.min(360, angle)) };
    commit({ ...doc, features: [...doc.features, f] });
    setPendingRevolve(null);
    setActiveId(f.id);
  };

  // ---- floating overlay ------------------------------------------------------------
  const overlay = useMemo<Overlay | null>(() => {
    if (!enabled) return null;
    if (pendingRevolve && !drag) {
      const ring = revolveRing(pendingRevolve);
      if (!ring) return null;
      return {
        anchor: ring.center,
        content: (
          <div className="ov-menu">
            <strong className="ov-title">↻ Revolve · axis {ring.label}</strong>
            <span className="ov-hint">drag the ring, or type the angle</span>
            <label className="ov-field">
              <span>Angle °</span>
              <ExprInput value={0} scope={scope} onCommit={({ value }) => finishRevolve(value)} />
            </label>
            <button onClick={() => setPendingRevolve(null)} title="Cancel (Esc)">
              Cancel
            </button>
          </div>
        ),
      };
    }
    if (axisPick) {
      const sk = sketches.find((x) => x.id === axisPick.sketch);
      const r = sk?.regions.find((x) => x.id === axisPick.regions?.[0]) ?? sk?.regions[0];
      const anchor = sk ? (r ? onPlane(sk, r.inside) : sk.frame.origin) : null;
      if (!anchor) return null;
      const lines = axisCandidates.filter((c) => !c.world).length;
      return {
        anchor,
        content: (
          <div className="ov-menu">
            <strong className="ov-title">↻ Revolve</strong>
            <span className="ov-hint">
              pick the axis: {lines ? "a line of the sketch or " : ""}a world axis{lines ? "" : " · add a construction line to the sketch for your own axis"}
            </span>
            <button onClick={() => setAxisPick(null)} title="Cancel (Esc)">
              Cancel
            </button>
          </div>
        ),
      };
    }
    if (!mesh) return null;
    if (drag) {
      const h = dragHandles(drag, rigid)[0];
      const anchor = h ? (h.kind === "arrow" ? h.origin : h.center) : drag.anchor;
      return { anchor, content: <div className="ov-value live">{formatDrag(drag)}</div> };
    }

    if (active) {
      const anchor = active.type === "extrude" ? (extrudeSpot(active)?.p ?? null) : active.type === "revolve" ? (revolveRing(active)?.center ?? null) : active.type === "cove" ? (coveSpot(active)?.p ?? null) : activeAnchor(active, mesh);
      if (!anchor) return null;
      return { anchor, content: <ActiveEditor feature={active} scope={scope} doc={doc} commit={commit} onDone={clear} /> };
    }

    const buttons: ReactNode[] = [];
    let anchor: Vec3 | null = null;
    /** Toolbar commands that apply to this selection, as buttons in the menu. */
    const extra = (kind: keyof ContextActions) => {
      for (const c of contextActions?.()[kind] ?? []) {
        const run = () => contextActions?.()[kind]?.find((x) => x.id === c.id && !x.disabled)?.run();
        buttons.push(
          <button key={`x-${c.id}`} title={c.title} onClick={run}>
            {c.icon && <Icon name={c.icon} />} {c.label}
          </button>,
        );
      }
    };
    if (regionSpot) {
      anchor = regionSpot.p;
      const sk = regionSpot.sketch;
      const name = doc.features.find((f) => f.id === sk.id)?.name ?? "sketch";
      const regions = live.regions.map((r) => r.id);
      const add = (f: Feature) => {
        commit({ ...doc, features: [...doc.features, f] });
        setActiveId(f.id);
        setSelection(EMPTY);
      };
      buttons.push(<strong key="t" className="ov-title">{regions.length > 1 ? `${regions.length} regions` : "Region"} · {name}</strong>);
      buttons.push(
        <button
          key="ex"
          onClick={() => {
            const { op, target } = autoOperation(mesh, regionSpot.p, regionSpot.n, 10);
            add({ ...makeExtrude(doc, sk.id, op), regions, distance: 10, target });
          }}
        >
          <Icon name="extrude" /> Extrude
        </button>,
      );
      buttons.push(
        <button key="rv" onClick={() => startRevolve(sk.id, regions)} title="Revolve around an axis you pick next">
          <Icon name="revolve" /> Revolve
        </button>,
      );
      buttons.push(<span key="h" className="ov-hint">drag the arrow · into the solid cuts</span>);
    } else if (coveSel) {
      const f = coveSel.feature;
      anchor = faceAnchor(mesh, coveSel.face)?.p ?? null;
      buttons.push(<strong key="t" className="ov-title">{f.name}</strong>);
      buttons.push(
        <label key="v" className="ov-field">
          <span>R</span>
          <ExprInput value={f.size} expr={f.exprs?.size} scope={scope} min={0.01} onCommit={({ value, expr }) => commit(updateFeature(doc, f.id, { size: value, exprs: expr ? { ...f.exprs, size: expr } : undefined } as Partial<Feature>))} />
        </label>,
      );
      buttons.push(<span key="h" className="ov-hint">{f.edges.length > 1 ? `all ${f.edges.length} edges · ` : ""}drag the arrow</span>);
    } else if (blend) {
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
        buttons.push(
          <button key="sk" onClick={() => onSketchOnFace(singlePlanarFace)}>
            <Icon name="sketch" /> Sketch
          </button>,
        );
      }
      buttons.push(
        <button key="sh" onClick={() => (onAddFeature(makeShell(doc, live.faces)), clear())}>
          <Icon name="shell" /> Shell
        </button>,
      );
      if (live.faces.every((n) => mesh.faceCylindrical?.[mesh.faceNames.indexOf(n)])) extra("cylinder");
      else extra(singlePlanarFace ? "face" : "faces");
      if (singlePlanarFace) buttons.push(<span key="hint" className="ov-hint">drag the arrow to push/pull</span>);
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
            <Icon name={type} /> {type === "fillet" ? "Fillet" : "Chamfer"}
          </button>,
        );
      }
      buttons.push(
        <button
          key="cove"
          title="Concave quarter-round groove along the edges"
          onClick={() => {
            const f = makeCove(doc, live.edges.filter((e) => edgeFrame(mesh, e)), 2);
            commit({ ...doc, features: [...doc.features, f] });
            setActiveId(f.id);
            setSelection(EMPTY);
          }}
        >
          <Icon name="cove" /> Cove
        </button>,
      );
      extra("edge");
      buttons.push(<span key="n" className="ov-hint">{live.edges.length} edge{live.edges.length > 1 ? "s" : ""} · drag the arrow</span>);
    } else if (live.body) {
      anchor = bodyBounds(mesh, live.body)?.center ?? null;
      buttons.push(<strong key="t" className="ov-title">{bodyName(live.body)}</strong>);
      extra("body");
      buttons.push(<span key="b" className="ov-hint">drag arrows to move, ring to rotate</span>);
    }
    return anchor && buttons.length ? { anchor, content: <div className="ov-menu">{buttons}</div> } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, mesh, drag, rigid, active, blend, coveSel, regionSpot, axisPick, axisCandidates, pendingRevolve, live.faces.join(","), live.edges.join(","), live.body, singlePlanarFace, doc, scope, sketches]);

  /** Shows the handles and value box of an existing feature (picked in the history). */
  const activate = useCallback((id: string | null) => {
    setSelection(EMPTY);
    setActiveId(id);
  }, []);

  return { selection: live, pickFace, pickEdge, pickBody, pickRegion, clear, activate, startRevolve, axisCandidates, pickAxis, pickingAxis: !!axisPick, handles, onHandleDrag, overlay, dragging, rigid, ghost, sweep, hiddenFaces, singlePlanarFace, activeId };
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
  if (d.handle === "extrude" ||
    d.handle === "cove" ||
    d.handle === "pushpull" || d.handle === "fillet" || d.handle === "refillet") {
    // The grabbed arrow follows the value along its direction.
    const k = d.value;
    const origin: Vec3 = [d.anchor[0] + d.dir[0] * k, d.anchor[1] + d.dir[1] * k, d.anchor[2] + d.dir[2] * k];
    return [{ id: d.handle, kind: "arrow", origin, dir: d.dir, color: 0xffc53d }];
  }
  // A revolve keeps just its ring, around the axis.
  if (d.handle === "revolve") return [{ id: "revolve", kind: "ring", center: d.anchor, axis: d.dir, color: 0xffc53d, arc: 120, turn: d.value }];
  // Body gizmo moves with the body.
  const c = new THREE.Vector3(...d.anchor);
  if (rigid) c.applyMatrix4(new THREE.Matrix4().fromArray(rigid.matrix));
  return bodyGizmo([c.x, c.y, c.z]).map((h) => (h.id === d.handle ? { ...h, color: 0xffc53d, ...(h.kind === "ring" ? { turn: d.value } : {}) } : h));
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
    case "revolve":
      return `↻ ${(d.feature as RevolveFeature).angle}°`;
    case "extrude": {
      const op = (d.feature as ExtrudeFeature).op;
      return `${OP_LABEL[op]} ${Math.abs(v)} mm`;
    }
    case "fillet":
    case "refillet":
    case "cove":
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
      {f.type === "revolve" && (
        <>
          {field("angle", "Angle °")}
          <select
            className="ov-select"
            value={f.axisLine ?? f.axis}
            title="Axis"
            onChange={(e) => {
              const v = e.target.value;
              set(v === "X" || v === "Y" || v === "Z" ? ({ axis: v, axisLine: undefined } as Partial<Feature>) : ({ axisLine: v } as Partial<Feature>));
            }}
          >
            {sketchLines((doc.features.find((x) => x.id === f.sketchId && x.type === "sketch") as SketchFeature | undefined)?.sketch ?? { entities: [], constraints: [] }).map((l) => (
              <option key={l.id} value={l.id}>
                Axis: {l.label}
              </option>
            ))}
            <option value="X">Axis: world X</option>
            <option value="Y">Axis: world Y</option>
            <option value="Z">Axis: world Z</option>
          </select>
          <select className="ov-select" value={f.op} onChange={(e) => set({ op: e.target.value as BooleanOp })} title="Operation">
            {(["new", "join", "cut"] as const).map((op) => (
              <option key={op} value={op}>
                {OP_LABEL[op]}
              </option>
            ))}
          </select>
        </>
      )}
      {f.type === "extrude" && (
        <>
          {!(f.throughAll && f.op === "cut") && field("distance", "Distance")}
          <select className="ov-select" value={f.op} onChange={(e) => set({ op: e.target.value as BooleanOp })} title="Operation">
            {(["new", "join", "cut"] as const).map((op) => (
              <option key={op} value={op}>
                {OP_LABEL[op]}
              </option>
            ))}
          </select>
          {f.op === "cut" && (
            <label className="ov-check" title="Cut through the whole body">
              <input type="checkbox" checked={!!f.throughAll} onChange={(e) => set({ throughAll: e.target.checked })} /> Through all
            </label>
          )}
        </>
      )}
      {f.type === "cove" && field("size", "Radius", 0.01)}
      {(f.type === "fillet" || f.type === "chamfer") && (
        <>
          {field("size", f.type === "fillet" ? "Radius" : "Distance", 0.01)}
          <button onClick={() => set({ type: f.type === "fillet" ? "chamfer" : "fillet", name: f.name.replace(/^(Fillet|Chamfer)/, f.type === "fillet" ? "Chamfer" : "Fillet") } as Partial<Feature>)}>
            <Icon name={f.type === "fillet" ? "chamfer" : "fillet"} /> {f.type === "fillet" ? "Chamfer" : "Fillet"}
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

const OP_LABEL: Record<BooleanOp, string> = { new: "New body", join: "Join", cut: "Cut", intersect: "Intersect" };

/** World position of a point given in a sketch's plane coordinates. */
function onPlane(sk: SketchPreview, [u, v]: [number, number]): Vec3 {
  const { origin: o, x, y } = sk.frame;
  return [o[0] + x[0] * u + y[0] * v, o[1] + x[1] * u + y[1] * v, o[2] + x[2] * u + y[2] * v];
}

/**
 * Operation for extruding a region from point `p` on its plane by `distance`
 * along `n`: into a body cuts it, out of a body it touches joins it, and
 * anywhere else makes a new body.
 */
export function autoOperation(mesh: MeshData | null, p: Vec3, n: Vec3, distance: number): { op: BooleanOp; target?: BodyId } {
  if (!mesh || distance === 0) return { op: "new" };
  const k = Math.sign(distance) * Math.min(0.05, Math.abs(distance) / 2);
  const ahead: Vec3 = [p[0] + n[0] * k, p[1] + n[1] * k, p[2] + n[2] * k];
  const behind: Vec3 = [p[0] - n[0] * k, p[1] - n[1] * k, p[2] - n[2] * k];
  const into = bodyContaining(mesh, ahead);
  if (into) return { op: "cut", target: into };
  const touching = bodyContaining(mesh, behind);
  if (touching) return { op: "join", target: touching };
  return { op: "new" };
}

/** World axis of a revolve: its sketch line (in the sketch's plane) or a world axis through the origin. */
export function revolveAxis(doc: Document, f: RevolveFeature, sk: SketchPreview): { origin: Vec3; dir: Vec3; label: string } | null {
  if (f.axisLine) {
    const sketch = doc.features.find((x): x is SketchFeature => x.id === f.sketchId && x.type === "sketch");
    const m = sketch ? entityMap(sketch.sketch) : null;
    const line = m?.get(f.axisLine);
    if (!m || !line || line.kind !== "line") return null;
    const a = pointOf(m, line.p1), b = pointOf(m, line.p2);
    const o = onPlane(sk, [a.x, a.y]), e = onPlane(sk, [b.x, b.y]);
    const d: Vec3 = [e[0] - o[0], e[1] - o[1], e[2] - o[2]];
    const l = Math.hypot(...d) || 1;
    const label = sketchLines(sketch!.sketch).find((x) => x.id === f.axisLine)?.label ?? "line";
    return { origin: o, dir: [d[0] / l, d[1] / l, d[2] / l], label };
  }
  const dir: Vec3 = f.axis === "X" ? [1, 0, 0] : f.axis === "Y" ? [0, 1, 0] : [0, 0, 1];
  return { origin: [0, 0, 0], dir, label: `world ${f.axis}` };
}
