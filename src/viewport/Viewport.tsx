import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { MeshData, PlanePreview, SketchPreview } from "../model/types";
import type { Vec3 } from "../model/frame";
import { CameraNav, placeSketchCamera, type NavMode, type SketchCamera, type ViewName } from "./navigation";
import { SectionView, sectionRange, type SectionAxis, type SectionSpec } from "./section";
import { findOverhangs } from "./overhang";
import { Icon } from "../ui/icons";

const NAV_MODE_KEY = "openshape.navMode";
const readNavMode = (): NavMode => {
  try {
    const v = localStorage.getItem(NAV_MODE_KEY);
    return v === "mouse" || v === "trackpad" ? v : "auto";
  } catch {
    return "auto";
  }
};

export interface HoverInfo {
  face?: string;
  edge?: string;
  region?: string;
  sketch?: string;
}

/** On-model manipulators. Arrows report a signed distance, rings an angle in degrees. */
export type Handle =
  | { id: string; kind: "arrow"; origin: Vec3; dir: Vec3; color: number }
  /** `arc` (degrees) draws only part of the ring, centered on the knob; full circle when absent. */
  | { id: string; kind: "ring"; center: Vec3; axis: Vec3; color: number; arc?: number; toward?: Vec3; turn?: number };

export type DragPhase = "start" | "move" | "end";

export interface Overlay {
  /** World point the overlay sticks to. */
  anchor: Vec3;
  content: ReactNode;
}

interface Props {
  mesh: MeshData | null;
  sketches: SketchPreview[];
  selectedSketchId: string | null;
  onHover: (info: HoverInfo | null) => void;
  /** Only edges are pickable (editing a fillet/chamfer). */
  edgesOnly: boolean;
  selectedEdges: string[];
  selectedFaces: string[];
  /** Body to outline as selected. */
  selectedBody: string | null;
  onPickEdge: (name: string, additive: boolean) => void;
  /** Click on a face (null = empty space); `additive` with Shift/Cmd. */
  onPickFace: (name: string | null, additive: boolean) => void;
  /** Double click on a face selects its body. */
  onPickBody: (bodyId: string) => void;
  handles: Handle[];
  onHandleDrag: (id: string, value: number, phase: DragPhase) => void;
  overlay: Overlay | null;
  /** Body drawn with an extra transform while it's being moved (no kernel round trip). */
  rigidPreview: { body: string; matrix: number[] } | null;
  /** Translucent prism showing a push/pull before the kernel result arrives. */
  ghost: { mesh: MeshData; face: string; distance: number } | null;
  /** Translucent swept volume of an extrude or revolve being dragged. */
  sweep?: { positions: Float32Array; cut: boolean; fillet?: { normals: Float32Array; bands: Float32Array } } | null;
  /** Faces not drawn (e.g. a fillet whose new radius is being previewed). */
  hiddenFaces?: string[];
  /** Changing this number re-frames the model (new/opened document). */
  fitKey: number;
  /**
   * While sketching: the camera looks straight at the sketch plane, centered
   * on (cx, cy) in plane coordinates, at `scale` pixels per mm, so the 2D
   * editor drawn on top lines up with the model.
   */
  sketchCamera?: SketchCamera | null;
  /** Sketch not drawn in 3D (the one being edited draws itself). */
  hiddenSketchId?: string | null;
  /** Sketch regions that can be clicked, as "sketchId/regionId" keys. */
  pickableRegions?: Set<string>;
  /** Selected regions ("sketchId/regionId"). */
  selectedRegions?: string[];
  onPickRegion?: (sketchId: string, regionId: string, additive: boolean) => void;
  /** Double click on a sketch region opens the sketch. */
  onEditSketch?: (sketchId: string) => void;
  /** 3D printing: the build plate under the model (centred under it, at z = 0), red when the model doesn't fit. */
  bed?: { size: [number, number, number]; center: [number, number]; fits: boolean } | null;
  /** Construction planes, drawn translucent; a click selects one. */
  planes?: PlanePreview[];
  selectedPlane?: string | null;
  onPickPlane?: (id: string) => void;
  /** While choosing a revolve axis: the lines to pick from (clicks pick only these). */
  axisCandidates?: { id: string; a: Vec3; b: Vec3; world: boolean }[];
  onPickAxis?: (id: string) => void;
}

export const regionKey = (sketchId: string, regionId: string) => `${sketchId}/${regionId}`;


const mat = (color: number) => new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const BODY = mat(0xb8c4d6);
const HOVER = mat(0x4f8cff);
const SELECTED = mat(0xff6b93);
const BODY_SELECTED = mat(0xc9d8f2);
const EDGE = new THREE.LineBasicMaterial({ color: 0x1d2633 });
const SKETCH = new THREE.LineBasicMaterial({ color: 0xff9f1a });
const SKETCH_SEL = new THREE.LineBasicMaterial({ color: 0xff3d71 });
const EDGE_SELECTED = new LineMaterial({ color: 0xff3d71, linewidth: 2.5, worldUnits: false });
const EDGE_HOVER = new LineMaterial({ color: 0x4f8cff, linewidth: 2.5, worldUnits: false });
const AXIS = new LineMaterial({ color: 0x8e6cf0, linewidth: 2.5, worldUnits: false });
const AXIS_WORLD = new LineMaterial({ color: 0x8e6cf0, linewidth: 2, worldUnits: false, dashed: true, dashSize: 4, gapSize: 3, transparent: true, opacity: 0.7 });
const AXIS_HOVER = new LineMaterial({ color: 0x4f8cff, linewidth: 4, worldUnits: false });
const HIDDEN = new THREE.MeshBasicMaterial({ visible: false });
// Construction planes.
const PLANE = new THREE.MeshBasicMaterial({ color: 0x6b8aff, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide });
const PLANE_SEL = new THREE.MeshBasicMaterial({ color: 0x2f6fed, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
const PLANE_EDGE = new THREE.LineBasicMaterial({ color: 0x6b8aff });
const PLANE_EDGE_SEL = new THREE.LineBasicMaterial({ color: 0x2f6fed });
// Print bed and build volume.
const BED = new THREE.MeshBasicMaterial({ color: 0x9aa7b8, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const BED_EDGE = new THREE.LineBasicMaterial({ color: 0x6b7a90 });
const BED_EDGE_BAD = new THREE.LineBasicMaterial({ color: 0xe5484d });
const BED_VOLUME = new THREE.LineBasicMaterial({ color: 0x9aa7b8, transparent: true, opacity: 0.45 });
// Overhang analysis: faces that need support, drawn over the body.
const OVERHANG = new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
// Sketch regions: drawn just in front of coplanar faces.
const regionMat = (color: number, opacity: number) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
const REGION = regionMat(0xff9f1a, 0.1);
const REGION_HOVER = regionMat(0x4f8cff, 0.25);
const REGION_SEL = regionMat(0xff3d71, 0.3);
const GHOST_ADD = new THREE.MeshBasicMaterial({ color: 0x4f8cff, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
// Fillet preview: a shaded rounded surface drawn over the solid, and the face bands it removes.
const FILLET_ARC = new THREE.MeshStandardMaterial({ color: 0xff9ab8, metalness: 0.05, roughness: 0.45, transparent: true, opacity: 0.92, depthTest: false, side: THREE.DoubleSide });
const FILLET_BAND = new THREE.MeshBasicMaterial({ color: 0xff3d71, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
const GHOST_CUT = new THREE.MeshBasicMaterial({ color: 0xff3d71, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });

interface HandleObject {
  handle: Handle;
  group: THREE.Group;
  collider: THREE.Object3D;
  /** Ring knob: kept facing the camera. */
  knob?: THREE.Object3D;
  /** Ring contents, turned about the axis while dragging so the knob follows the cursor. */
  spin?: THREE.Object3D;
}

interface SceneState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  model: THREE.Group;
  overlay: THREE.Group;
  gizmos: THREE.Group;
  handleObjects: HandleObject[];
  body: THREE.Mesh | null;
  edgeLines: THREE.LineSegments | null;
  mesh: MeshData | null;
  hoveredFace: number | null;
  hoveredEdge: number | null;
  hoveredHandle: string | null;
  selectedFaces: Set<string>;
  selectedBody: string | null;
  /** Body hidden from the main mesh because a rigid preview draws it. */
  hiddenBody: string | null;
  hiddenFaces: Set<string>;
  rigid: { body: string; group: THREE.Group; others: THREE.LineSegments } | null;
  ghost: THREE.Mesh | null;
  sweep: THREE.Object3D | null;
  dragging: boolean;
  nav: CameraNav | null;
  /** Bounds of the current mesh, for fit and standard views. */
  box: THREE.Box3 | null;
  /** Pickable sketch region meshes. */
  regions: { mesh: THREE.Mesh; key: string; sketch: string; id: string }[];
  hoveredRegion: string | null;
  selectedRegions: Set<string>;
  /** Revolve axis candidates being offered. */
  axisGroup: THREE.Group;
  axes: { line: LineSegments2; id: string; world: boolean }[];
  hoveredAxis: string | null;
  fitted: boolean;
  /** Print bed and build volume (not pickable). */
  bedGroup: THREE.Group;
  /** Construction planes and their pickable squares. */
  planeGroup: THREE.Group;
  planes: { mesh: THREE.Mesh; id: string }[];
  /** Live section: clipping plane and cap. */
  section: SectionView;
  sectionSpec: SectionSpec | null;
  /** Overhang analysis: limit angle (degrees from vertical) when on, its overlay, and who wants the area. */
  overhangAngle: number | null;
  overhang: THREE.Mesh | null;
  onOverhangs: ((area: number | null) => void) | null;
}

/** Recomputes the overhang overlay for the current mesh. */
function refreshOverhangs(s: SceneState) {
  if (s.overhang) {
    s.overhang.parent?.remove(s.overhang);
    s.overhang.geometry.dispose();
    s.overhang = null;
  }
  let area: number | null = null;
  if (s.overhangAngle !== null && s.mesh) {
    const o = findOverhangs(s.mesh, s.overhangAngle);
    area = o.area;
    if (o.positions.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(o.positions, 3));
      s.overhang = new THREE.Mesh(g, OVERHANG);
      s.overhang.raycast = () => {}; // not pickable: clicks go to the faces below
      s.model.add(s.overhang);
    }
  }
  s.onOverhangs?.(area);
}

export function Viewport(props: Props) {
  const { mesh, sketches, selectedSketchId, selectedEdges, selectedFaces, selectedBody, handles, overlay, rigidPreview, ghost } = props;
  const host = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const state = useRef<SceneState | null>(null);
  const latest = useRef(props);
  latest.current = props;

  // One-time scene setup.
  useEffect(() => {
    const el = host.current!;
    // Stencil buffer: the section cap is drawn through it.
    const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.localClippingEnabled = true;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xeef1f5);

    // CAD convention: Z up.
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000);
    camera.up.set(0, 0, 1);
    camera.position.set(90, -110, 80);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(80, -60, 120);
    camera.add(sun);
    scene.add(camera);

    const grid = new THREE.GridHelper(200, 20, 0xb0b8c4, 0xd5dae1);
    grid.rotation.x = Math.PI / 2;
    scene.add(grid);
    scene.add(new THREE.AxesHelper(25));

    const model = new THREE.Group();
    const overlayGroup = new THREE.Group();
    const gizmos = new THREE.Group();
    const axisGroup = new THREE.Group();
    const planeGroup = new THREE.Group();
    const bedGroup = new THREE.Group();
    scene.add(model, overlayGroup, gizmos, axisGroup, planeGroup, bedGroup);
    const section = new SectionView([BODY, HOVER, SELECTED, BODY_SELECTED, EDGE, EDGE_SELECTED, EDGE_HOVER, SKETCH, SKETCH_SEL, OVERHANG]);
    scene.add(section.group);

    const s: SceneState = {
      renderer, scene, camera, controls, model, overlay: overlayGroup, gizmos, handleObjects: [],
      body: null, edgeLines: null, mesh: null, hoveredFace: null, hoveredEdge: null, hoveredHandle: null,
      selectedFaces: new Set(), selectedBody: null, hiddenBody: null, hiddenFaces: new Set(), rigid: null, ghost: null, sweep: null, dragging: false, nav: null, box: null, fitted: false,
      regions: [], hoveredRegion: null, selectedRegions: new Set(), axisGroup, axes: [], hoveredAxis: null,
      section, sectionSpec: null, planeGroup, planes: [], bedGroup, overhangAngle: null, overhang: null, onOverhangs: null,
    };
    /** First hit on the kept side of the section plane (the removed half isn't there). */
    const kept = <T extends THREE.Intersection>(hits: T[]): T | undefined => hits.find((h) => section.keeps(h.point));
    state.current = s;

    // Navigation: zoom towards the model point under the cursor.
    const pickRay = new THREE.Raycaster();
    const nav = new CameraNav(camera, controls, renderer.domElement, (cx, cy) => {
      if (!s.body) return null;
      const r = renderer.domElement.getBoundingClientRect();
      pickRay.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
      return kept(pickRay.intersectObject(s.body))?.point ?? null;
    });
    nav.mode = readNavMode();
    s.nav = nav;

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = el;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      EDGE_SELECTED.resolution.set(w, h);
      EDGE_HOVER.resolution.set(w, h);
      for (const m of [AXIS, AXIS_WORLD, AXIS_HOVER]) m.resolution.set(w, h);
      HANDLE_RES.set(w, h);
      for (const m of HANDLE_LINES) m.resolution.set(w, h);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const setRay = (ev: { clientX: number; clientY: number }) => {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      // ~6 px pick tolerance for edges, in world units at the target distance.
      const dist = camera.position.distanceTo(controls.target);
      ray.params.Line = { threshold: (dist * Math.tan((camera.fov * Math.PI) / 360) * 2 * 6) / r.height };
    };

    const pickHandle = (): HandleObject | null => {
      const hit = ray.intersectObjects(s.handleObjects.map((h) => h.collider), false)[0];
      return hit ? s.handleObjects.find((h) => h.collider === hit.object) ?? null : null;
    };

    /** Index into mesh.edgeGroups of the edge under the cursor, if it's in front of the body. */
    const pickEdge = (): number | null => {
      if (!s.edgeLines || !s.mesh) return null;
      const bodyHit = s.body ? kept(ray.intersectObject(s.body)) : undefined;
      // Pixel tolerance measured where the cursor actually is (not at the orbit target),
      // and tighter over fillet faces so thin blends stay selectable.
      const r = renderer.domElement.getBoundingClientRect();
      const dist = bodyHit?.distance ?? camera.position.distanceTo(controls.target);
      let px = 6;
      if (bodyHit?.faceIndex != null) {
        const idx = bodyHit.faceIndex * 3;
        const fi = s.mesh.faceGroups.findIndex((g) => idx >= g.start && idx < g.start + g.count);
        // Fillet and cove faces can be thin: their own edges mustn't swallow every click on them.
        if (fi >= 0 && /:blend:|:cove:/.test(s.mesh.faceNames[fi])) px = 2;
      }
      ray.params.Line = { threshold: (dist * Math.tan((camera.fov * Math.PI) / 360) * 2 * px) / r.height };
      const hit = kept(ray.intersectObject(s.edgeLines));
      if (!hit || hit.index == null) return null;
      if (bodyHit && bodyHit.distance < hit.distance - 0.5) return null; // occluded
      const i = s.mesh.edgeGroups.findIndex((g) => hit.index! >= g.start && hit.index! < g.start + g.count);
      return i < 0 ? null : i;
    };

    /** Revolve axis candidate under the cursor (a few pixels of tolerance). */
    const pickAxis = (): SceneState["axes"][number] | null => {
      if (!s.axes.length) return null;
      ray.params.Line2 = { threshold: 6 };
      const hit = ray.intersectObjects(s.axes.map((x) => x.line), false)[0];
      return hit ? (s.axes.find((x) => x.line === hit.object) ?? null) : null;
    };

    /** Sketch region under the cursor, unless the body is in front of it. */
    const pickRegion = (): SceneState["regions"][number] | null => {
      if (!s.regions.length) return null;
      const hit = ray.intersectObjects(s.regions.map((r) => r.mesh), false)[0];
      if (!hit) return null;
      const bodyHit = s.body ? kept(ray.intersectObject(s.body)) : undefined;
      if (bodyHit && bodyHit.distance < hit.distance - 0.05) return null;
      return s.regions.find((r) => r.mesh === hit.object) ?? null;
    };

    /** Construction plane under the cursor, unless the body is in front of it. */
    const pickPlane = (): string | null => {
      if (!s.planes.length) return null;
      const hit = kept(ray.intersectObjects(s.planes.map((p) => p.mesh), false));
      if (!hit) return null;
      const bodyHit = s.body ? kept(ray.intersectObject(s.body)) : undefined;
      if (bodyHit && bodyHit.distance < hit.distance - 0.05) return null;
      return s.planes.find((p) => p.mesh === hit.object)?.id ?? null;
    };

    const pickFace = (): number | null => {
      if (!s.body || !s.mesh) return null;
      const hit = kept(ray.intersectObject(s.body));
      if (hit?.faceIndex == null) return null;
      const idx = hit.faceIndex * 3;
      const i = s.mesh.faceGroups.findIndex((g) => idx >= g.start && idx < g.start + g.count);
      return i < 0 ? null : i;
    };

    // ---- handle dragging ------------------------------------------------------
    let drag: { h: HandleObject; t0: number; last: number } | null = null;

    /** Parameter along the arrow line closest to the mouse ray. */
    const arrowParam = (o: Vec3, d: Vec3): number => {
      const r0 = ray.ray.origin, rd = ray.ray.direction;
      const w0 = new THREE.Vector3(o[0] - r0.x, o[1] - r0.y, o[2] - r0.z);
      const dv = new THREE.Vector3(...d);
      const b = dv.dot(rd), dd = dv.dot(w0), e = rd.dot(w0);
      const den = 1 - b * b;
      return Math.abs(den) < 1e-6 ? 0 : (b * e - dd) / den;
    };

    /** Angle (degrees) of the mouse around a ring's axis. */
    const ringAngle = (c: Vec3, axis: Vec3): number | null => {
      const n = new THREE.Vector3(...axis).normalize();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(...c));
      const p = ray.ray.intersectPlane(plane, new THREE.Vector3());
      if (!p) return null;
      const ref = Math.abs(n.z) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      const u = ref.clone().sub(n.clone().multiplyScalar(ref.dot(n))).normalize();
      const v = n.clone().cross(u);
      const q = p.sub(new THREE.Vector3(...c));
      return (Math.atan2(q.dot(v), q.dot(u)) * 180) / Math.PI;
    };

    const handleValue = (h: Handle): number | null => (h.kind === "arrow" ? arrowParam(h.origin, h.dir) : ringAngle(h.center, h.axis));

    const onMove = (ev: PointerEvent) => {
      setRay(ev);
      if (drag) {
        const v = handleValue(drag.h.handle);
        if (v == null) return;
        let value = v - drag.t0;
        // Rings report an angle in (-180, 180]: follow it continuously so a drag can go round.
        if (drag.h.handle.kind === "ring") value = drag.last + ((((value - drag.last) % 360) + 540) % 360) - 180;
        drag.last = value;
        latest.current.onHandleDrag(drag.h.handle.id, value, "move");
        return;
      }
      if (ev.buttons) return;
      // Choosing a revolve axis: only the candidate lines react.
      if (s.axes.length) {
        const a = pickAxis();
        if ((a?.id ?? null) !== s.hoveredAxis) {
          s.hoveredAxis = a?.id ?? null;
          styleAxes(s);
          renderer.domElement.style.cursor = a ? "pointer" : "";
        }
        return;
      }
      const h = pickHandle();
      const hid = h?.handle.id ?? null;
      if (hid !== s.hoveredHandle) {
        s.hoveredHandle = hid;
        renderer.domElement.style.cursor = hid ? "grab" : "";
        styleHandles(s);
      }
      if (h) return;
      const edge = s.mesh ? pickEdge() : null;
      const region = edge == null && !latest.current.edgesOnly ? pickRegion() : null;
      if ((region?.key ?? null) !== s.hoveredRegion) {
        s.hoveredRegion = region?.key ?? null;
        applyRegionMaterials(s);
        if (region) latest.current.onHover({ region: region.id, sketch: region.sketch });
      }
      if (!s.mesh) return;
      const face = edge == null && !region && !latest.current.edgesOnly ? pickFace() : null;
      if (edge !== s.hoveredEdge || face !== s.hoveredFace) {
        s.hoveredEdge = edge;
        s.hoveredFace = face;
        applyFaceMaterials(s);
        rebuildOverlay(s, latest.current.selectedEdges);
        const m = s.mesh;
        if (!region) latest.current.onHover(edge != null ? { edge: m.edgeNames[edge] } : face != null ? { face: m.faceNames[face] } : null);
      }
    };

    // Distinguish a click from an orbit drag.
    let down: { x: number; y: number } | null = null;
    const onDown = (ev: PointerEvent) => {
      down = { x: ev.clientX, y: ev.clientY };
      if (ev.button !== 0) return;
      setRay(ev);
      const h = pickHandle();
      if (!h) return;
      const t0 = handleValue(h.handle);
      if (t0 == null) return;
      drag = { h, t0, last: 0 };
      s.dragging = true;
      controls.enabled = false;
      try {
        renderer.domElement.setPointerCapture(ev.pointerId);
      } catch {
        /* synthetic or already-released pointer: dragging still works without capture */
      }
      renderer.domElement.style.cursor = "grabbing";
      latest.current.onHandleDrag(h.handle.id, 0, "start");
    };
    const onUp = (ev: PointerEvent) => {
      if (drag) {
        const d = drag;
        drag = null;
        s.dragging = false;
        controls.enabled = true;
        renderer.domElement.style.cursor = "grab";
        latest.current.onHandleDrag(d.h.handle.id, d.last, "end");
        down = null;
        return;
      }
      const d = down;
      down = null;
      if (!d || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 4 || ev.button !== 0) return;
      setRay(ev);
      if (s.axes.length) {
        const a = pickAxis();
        if (a) latest.current.onPickAxis?.(a.id);
        return;
      }
      const additive = ev.shiftKey || ev.metaKey;
      const edge = s.mesh ? pickEdge() : null;
      if (edge != null) return latest.current.onPickEdge(s.mesh!.edgeNames[edge], additive);
      if (latest.current.edgesOnly) return;
      const plane = pickPlane();
      if (plane) return latest.current.onPickPlane?.(plane);
      const region = pickRegion();
      if (region) return latest.current.onPickRegion?.(region.sketch, region.id, additive);
      if (!s.mesh) return latest.current.onPickFace(null, additive);
      const face = pickFace();
      latest.current.onPickFace(face != null ? s.mesh.faceNames[face] : null, additive);
    };
    const onDbl = (ev: MouseEvent) => {
      if (s.axes.length) return;
      setRay(ev);
      const region = pickRegion();
      if (region) return latest.current.onEditSketch?.(region.sketch);
      if (!s.mesh) return;
      const face = pickFace();
      if (face != null && s.mesh.faceBody[face]) latest.current.onPickBody(s.mesh.faceBody[face]);
    };
    const onLeave = () => {
      if (drag) return;
      s.hoveredEdge = s.hoveredFace = null;
      applyFaceMaterials(s);
      rebuildOverlay(s, latest.current.selectedEdges);
      latest.current.onHover(null);
    };
    const canvas = renderer.domElement;
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("dblclick", onDbl);
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      nav.wheel(ev);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    const tmp = new THREE.Vector3();
    let raf = 0;
    // Camera pose before sketching, restored afterwards.
    let saved: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
    const loop = () => {
      const sc = latest.current.sketchCamera;
      if (sc) {
        if (!saved) {
          saved = { pos: camera.position.clone(), target: controls.target.clone() };
          controls.enabled = false;
          nav.animateTo(camera.position.clone(), controls.target.clone(), 1); // cancels any running tween
        }
        placeSketchCamera(camera, controls.target, sc, el.clientHeight || 1);
      } else {
        if (saved) {
          camera.up.set(0, 0, 1);
          controls.enabled = true;
          nav.animateTo(saved.pos, saved.target);
          saved = null;
        }
        nav.update(performance.now());
        controls.update();
      }
      // Keep depth precision reasonable at any zoom.
      const d = camera.position.distanceTo(controls.target);
      camera.near = Math.max(0.01, d / 2000);
      camera.far = Math.max(1000, d * 50);
      camera.updateProjectionMatrix();
      // Handles are modelled in pixels: scale them to world units at their distance, so they
      // keep the same on-screen size at any zoom and window size.
      const perPixel = (2 * Math.tan((camera.fov * Math.PI) / 360)) / (el.clientHeight || 1);
      for (const ho of s.handleObjects) {
        const anchor = ho.handle.kind === "arrow" ? ho.handle.origin : ho.handle.center;
        const dist = camera.position.distanceTo(tmp.set(...anchor));
        ho.group.scale.setScalar(dist * perPixel);
        faceCamera(ho, camera);
      }
      // HTML overlay follows its anchor.
      const ov = latest.current.overlay;
      const div = overlayRef.current;
      if (div) {
        if (ov) {
          tmp.set(...ov.anchor).project(camera);
          const visible = tmp.z < 1;
          div.style.display = visible ? "block" : "none";
          div.style.transform = `translate(${((tmp.x + 1) / 2) * el.clientWidth}px, ${((1 - tmp.y) / 2) * el.clientHeight}px)`;
        } else div.style.display = "none";
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("dblclick", onDbl);
      canvas.removeEventListener("wheel", onWheel);
      controls.dispose();
      renderer.dispose();
      el.removeChild(canvas);
      state.current = null;
    };
  }, []);

  // Rebuild model geometry when the kernel returns a new result.
  useEffect(() => {
    const s = state.current;
    if (!s) return;
    clearGroup(s.model);
    s.body = null;
    s.edgeLines = null;
    s.mesh = mesh;
    if (mesh && mesh.vertices.length) {
      s.box = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(mesh.vertices, 3));
      // Frame the first model shown.
      if (!s.fitted) {
        s.fitted = true;
        s.nav?.fit(s.box, undefined, false);
      }
    } else s.box = null;
    s.hoveredFace = s.hoveredEdge = null;
    s.regions = [];
    s.hoveredRegion = null;

    if (mesh) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(mesh.vertices, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
      g.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
      s.body = new THREE.Mesh(g, [BODY, HOVER, SELECTED, BODY_SELECTED, HIDDEN]);
      applyFaceMaterials(s);
      s.model.add(s.body);

      const eg = new THREE.BufferGeometry();
      eg.setAttribute("position", new THREE.BufferAttribute(mesh.edges, 3));
      s.edgeLines = new THREE.LineSegments(eg, EDGE);
      s.model.add(s.edgeLines);
    }
    s.section.update(s.sectionSpec, s.body, s.box);
    s.overhang = null; // cleared with the model group
    refreshOverhangs(s);

    for (const sk of sketches) {
      if (sk.id === props.hiddenSketchId) continue;
      // Pickable regions: filled polygons on the sketch plane.
      const fr = sk.frame;
      const toWorld = new THREE.Matrix4().makeBasis(new THREE.Vector3(...fr.x), new THREE.Vector3(...fr.y), new THREE.Vector3(...fr.n)).setPosition(...fr.origin);
      for (const r of sk.regions ?? []) {
        const key = regionKey(sk.id, r.id);
        if (!props.pickableRegions?.has(key)) continue;
        const path = (a: Float32Array) => Array.from({ length: a.length / 2 }, (_, i) => new THREE.Vector2(a[i * 2], a[i * 2 + 1]));
        const shape = new THREE.Shape(path(r.outer));
        for (const h of r.holes) shape.holes.push(new THREE.Path(path(h)));
        const geom = new THREE.ShapeGeometry(shape, 1);
        geom.applyMatrix4(toWorld);
        const regionMesh = new THREE.Mesh(geom, REGION);
        regionMesh.renderOrder = 2;
        s.model.add(regionMesh);
        s.regions.push({ mesh: regionMesh, key, sketch: sk.id, id: r.id });
      }
      const lg = new THREE.BufferGeometry();
      lg.setAttribute("position", new THREE.BufferAttribute(sk.segments, 3));
      s.model.add(new THREE.LineSegments(lg, sk.id === selectedSketchId ? SKETCH_SEL : SKETCH));
    }
    rebuildOverlay(s, selectedEdges);
    // selectedEdges handled by its own effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
    applyRegionMaterials(s);
  }, [mesh, sketches, selectedSketchId, props.hiddenSketchId, props.pickableRegions]);

  useEffect(() => {
    const s = state.current;
    if (!s) return;
    s.hiddenFaces = new Set(props.hiddenFaces ?? []);
    applyFaceMaterials(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [(props.hiddenFaces ?? []).join("|")]);

  // Print bed: the plate at z = 0 under the model and the outline of the build volume.
  const bedKey = JSON.stringify(props.bed ?? null);
  useEffect(() => {
    const s = state.current;
    if (!s) return;
    clearGroup(s.bedGroup);
    const b = props.bed;
    if (!b) return;
    const [bx, by, bz] = b.size;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(bx, by), BED);
    plate.position.set(b.center[0], b.center[1], 0);
    plate.raycast = () => {};
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(bx, by, bz)), BED_VOLUME);
    box.position.set(b.center[0], b.center[1], bz / 2);
    box.raycast = () => {};
    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-bx / 2, -by / 2, 0), new THREE.Vector3(bx / 2, -by / 2, 0), new THREE.Vector3(bx / 2, by / 2, 0), new THREE.Vector3(-bx / 2, by / 2, 0)]),
      b.fits ? BED_EDGE : BED_EDGE_BAD,
    );
    outline.position.set(b.center[0], b.center[1], 0);
    outline.raycast = () => {};
    s.bedGroup.add(plate, box, outline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bedKey]);

  // Construction planes: a translucent square with its outline, at the plane's centre.
  const planesKey = JSON.stringify(props.planes ?? []) + (props.selectedPlane ?? "");
  useEffect(() => {
    const s = state.current;
    if (!s) return;
    clearGroup(s.planeGroup);
    s.planes = [];
    for (const p of props.planes ?? []) {
      const sel = p.id === props.selectedPlane;
      const { x, y, n } = p.frame;
      const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(...x), new THREE.Vector3(...y), new THREE.Vector3(...n)).setPosition(...p.center);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(p.size, p.size), sel ? PLANE_SEL : PLANE);
      mesh.applyMatrix4(basis);
      mesh.renderOrder = 2;
      const h = p.size / 2;
      const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-h, -h, 0), new THREE.Vector3(h, -h, 0), new THREE.Vector3(h, h, 0), new THREE.Vector3(-h, h, 0)]), sel ? PLANE_EDGE_SEL : PLANE_EDGE);
      outline.applyMatrix4(basis);
      outline.raycast = () => {};
      s.planeGroup.add(mesh, outline);
      s.planes.push({ mesh, id: p.id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planesKey]);

  // Revolve axis candidates.
  const axisKey = (props.axisCandidates ?? []).map((c) => c.id + c.a.join(",") + c.b.join(",")).join(";");
  useEffect(() => {
    const s = state.current;
    if (!s) return;
    clearGroup(s.axisGroup);
    s.axes = [];
    s.hoveredAxis = null;
    for (const c of props.axisCandidates ?? []) {
      const geo = new LineSegmentsGeometry();
      geo.setPositions([...c.a, ...c.b]);
      const line = new LineSegments2(geo, c.world ? AXIS_WORLD : AXIS);
      if (c.world) line.computeLineDistances();
      line.renderOrder = 12;
      s.axisGroup.add(line);
      s.axes.push({ line, id: c.id, world: c.world });
    }
    s.renderer.domElement.style.cursor = "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axisKey]);

  useEffect(() => {
    const s = state.current;
    if (!s) return;
    s.selectedRegions = new Set(props.selectedRegions ?? []);
    applyRegionMaterials(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.selectedRegions?.join(",")]);

  // The model turns translucent while sketching, so the sketch reads on top of it.
  const sketching = !!props.sketchCamera;
  useEffect(() => {
    for (const m of [BODY, BODY_SELECTED]) {
      m.transparent = sketching;
      m.opacity = sketching ? 0.45 : 1;
      m.needsUpdate = true;
    }
    EDGE.transparent = sketching;
    EDGE.opacity = sketching ? 0.5 : 1;
  }, [sketching]);

  useEffect(() => {
    if (state.current) rebuildOverlay(state.current, selectedEdges);
  }, [selectedEdges]);

  useEffect(() => {
    const s = state.current;
    if (!s) return;
    s.selectedFaces = new Set(selectedFaces);
    s.selectedBody = selectedBody;
    applyFaceMaterials(s);
  }, [selectedFaces, selectedBody, mesh]);

  useEffect(() => {
    const s = state.current;
    if (s) buildHandles(s, handles);
  }, [handles]);

  // A new or opened document: frame it as soon as its mesh arrives.
  useEffect(() => {
    if (state.current && props.fitKey) state.current.fitted = false;
  }, [props.fitKey]);

  // Rigid preview: build the moved body's geometry once, then only update its matrix.
  useEffect(() => {
    const s = state.current;
    if (!s) return;
    if (!rigidPreview || !s.mesh) {
      if (s.rigid) {
        s.scene.remove(s.rigid.group, s.rigid.others);
        s.rigid.group.traverse((o) => (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) && o.geometry.dispose());
        s.rigid.others.geometry.dispose();
        s.rigid = null;
        s.hiddenBody = null;
        if (s.edgeLines) s.edgeLines.visible = true;
        applyFaceMaterials(s);
      }
      return;
    }
    if (!s.rigid || s.rigid.body !== rigidPreview.body) {
      s.rigid = buildRigid(s.mesh, rigidPreview.body);
      s.scene.add(s.rigid.group, s.rigid.others);
      s.hiddenBody = rigidPreview.body;
      if (s.edgeLines) s.edgeLines.visible = false;
      applyFaceMaterials(s);
    }
    s.rigid.group.matrix.fromArray(rigidPreview.matrix);
    s.rigid.group.matrixWorldNeedsUpdate = true;
  }, [rigidPreview, mesh]);

  useEffect(() => {
    const s = state.current;
    if (!s) return;
    if (s.ghost) {
      s.scene.remove(s.ghost);
      s.ghost.geometry.dispose();
      s.ghost = null;
    }
    if (ghost) {
      const g = ghostPrism(ghost.mesh, ghost.face, ghost.distance);
      if (g) {
        s.ghost = new THREE.Mesh(g, ghost.distance > 0 ? GHOST_ADD : GHOST_CUT);
        s.ghost.renderOrder = 5;
        s.scene.add(s.ghost);
      }
    }
  }, [ghost]);

  useEffect(() => {
    const s = state.current;
    if (!s) return;
    if (s.sweep) {
      s.scene.remove(s.sweep);
      s.sweep.traverse((o) => o instanceof THREE.Mesh && o.geometry.dispose());
      s.sweep = null;
    }
    const sw = props.sweep;
    if (sw && sw.positions.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(sw.positions, 3));
      if (sw.fillet) {
        // A fillet lies inside the corner it rounds: draw it over the solid, shaded so the
        // curvature reads, with the bands it takes off the two faces underneath.
        g.setAttribute("normal", new THREE.BufferAttribute(sw.fillet.normals, 3));
        const group = new THREE.Group();
        const bands = new THREE.BufferGeometry();
        bands.setAttribute("position", new THREE.BufferAttribute(sw.fillet.bands, 3));
        const bandMesh = new THREE.Mesh(bands, FILLET_BAND);
        bandMesh.renderOrder = 6;
        const arcMesh = new THREE.Mesh(g, FILLET_ARC);
        arcMesh.renderOrder = 7;
        group.add(bandMesh, arcMesh);
        s.sweep = group;
      } else {
        const mesh = new THREE.Mesh(g, sw.cut ? GHOST_CUT : GHOST_ADD);
        mesh.renderOrder = 5;
        s.sweep = mesh;
      }
      s.scene.add(s.sweep);
    }
  }, [props.sweep]);

  return (
    <div className="viewport-wrap">
      <div ref={host} className={`viewport${props.edgesOnly ? " picking" : ""}`} />
      <ViewBar state={state} />
      <div ref={overlayRef} className="model-overlay" style={{ display: "none" }}>
        {overlay?.content}
      </div>
    </div>
  );
}

function styleAxes(s: SceneState) {
  for (const a of s.axes) a.line.material = a.id === s.hoveredAxis ? AXIS_HOVER : a.world ? AXIS_WORLD : AXIS;
}

function applyRegionMaterials(s: SceneState) {
  for (const r of s.regions) r.mesh.material = s.selectedRegions.has(r.key) ? REGION_SEL : r.key === s.hoveredRegion ? REGION_HOVER : REGION;
}

function applyFaceMaterials(s: SceneState) {
  if (!s.body || !s.mesh) return;
  const g = s.body.geometry;
  g.clearGroups();
  s.mesh.faceGroups.forEach((fg, i) => {
    const m = s.mesh!;
    const idx =
      (s.hiddenBody && m.faceBody[i] === s.hiddenBody) || s.hiddenFaces.has(m.faceNames[i]) ? 4 : i === s.hoveredFace ? 1 : s.selectedFaces.has(m.faceNames[i]) ? 2 : s.selectedBody && m.faceBody[i] === s.selectedBody ? 3 : 0;
    g.addGroup(fg.start, fg.count, idx);
  });
}

/** Thick overlay lines for selected (red) and hovered (blue) edges. */
function rebuildOverlay(s: SceneState, selected: string[]) {
  clearGroup(s.overlay);
  const m = s.mesh;
  if (!m) return;
  const wanted = new Set(selected);
  const collect = (pred: (i: number) => boolean) => {
    const pts: number[] = [];
    m.edgeGroups.forEach((g, i) => {
      if (!pred(i)) return;
      for (let k = g.start; k < g.start + g.count; k++) pts.push(m.edges[k * 3], m.edges[k * 3 + 1], m.edges[k * 3 + 2]);
    });
    return pts;
  };
  const add = (pts: number[], mat: LineMaterial) => {
    if (!pts.length) return;
    const geo = new LineSegmentsGeometry();
    geo.setPositions(pts);
    const l = new LineSegments2(geo, mat);
    l.renderOrder = 10;
    s.overlay.add(l);
  };
  add(collect((i) => wanted.has(m.edgeNames[i])), EDGE_SELECTED);
  if (s.hoveredEdge != null) add(collect((i) => i === s.hoveredEdge), EDGE_HOVER);
}

// ---- handle meshes -------------------------------------------------------------

/** Builds arrows and rings in a unit size; the render loop scales them per frame. */
function buildHandles(s: SceneState, handles: Handle[]) {
  // Same handles, new positions (during a drag): move them instead of rebuilding.
  if (handles.length && handles.length === s.handleObjects.length && handles.every((h, i) => h.id === s.handleObjects[i].handle.id && h.kind === s.handleObjects[i].handle.kind)) {
    handles.forEach((h, i) => {
      const ho = s.handleObjects[i];
      ho.group.position.set(...(h.kind === "arrow" ? h.origin : h.center));
      if (h.kind === "ring" && ho.spin) ho.spin.rotation.z = ((h.turn ?? 0) * Math.PI) / 180;
      // Outside a drag the ring may have moved round (e.g. a revolve's end after its angle changed).
      if (h.kind === "ring" && !s.dragging) orientRing(ho.group, h);
      // During a drag keep the original geometry: the drag measures from it.
      ho.handle = s.dragging ? { ...ho.handle, color: h.color } : h;
    });
    styleHandles(s);
    return;
  }
  clearGroup(s.gizmos);
  for (const m of HANDLE_LINES) m.dispose();
  HANDLE_LINES.length = 0;
  s.handleObjects = [];
  for (const h of handles) {
    const group = new THREE.Group();
    // Flat look: white fill with a dark outline (the body gizmo keeps its axis color on the outline).
    const fill = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, side: THREE.DoubleSide });
    const ink = h.id.startsWith("move-") || h.id === "rotate" ? h.color : INK;
    const flatFill = (geo: THREE.BufferGeometry) => {
      const m = new THREE.Mesh(geo, fill);
      m.userData.role = "fill";
      return m;
    };
    let collider: THREE.Object3D;
    let knob: THREE.Object3D | undefined;
    let spin: THREE.Object3D | undefined;
    // Sizes in screen pixels (see the render loop).
    if (h.kind === "arrow") {
      group.position.set(...h.origin);
      // One outline for shaft and head; the arrow lies in its local XY plane, +Y along `dir`.
      const pts: [number, number][] = [[-3, 9], [3, 9], [3, 54], [9.5, 54], [0, 74], [-9.5, 54], [-3, 54]];
      const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
      group.add(flatFill(new THREE.ShapeGeometry(shape)), outline(pts, true, ink));
      // Base dot.
      group.add(flatFill(new THREE.CircleGeometry(6, 24)), outline(circlePts(6, 0, Math.PI * 2, 24), true, ink));
      // Invisible collider about 18 px wide, so the handle is easy to grab.
      collider = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 80, 8), new THREE.MeshBasicMaterial({ visible: false }));
      collider.position.y = 36;
      group.add(collider);
    } else {
      group.position.set(...h.center);
      orientRing(group, h);
      const arc = ((h.arc ?? 360) * Math.PI) / 180;
      const a0 = h.arc ? -arc / 2 : 0;
      const R0 = 49, R1 = 55;
      // Everything turns together about the axis while dragging (see `turn`).
      const sp = new THREE.Group();
      sp.rotation.z = ((h.turn ?? 0) * Math.PI) / 180;
      group.add(sp);
      spin = sp;
      // A flat band in the ring's plane, edged on both sides (and at the ends of a partial ring).
      sp.add(flatFill(new THREE.RingGeometry(R0, R1, 96, 1, a0, arc)));
      const steps = Math.max(8, Math.round((96 * arc) / (Math.PI * 2)));
      sp.add(outline(circlePts(R0, a0, arc, steps), !h.arc, ink), outline(circlePts(R1, a0, arc, steps), !h.arc, ink));
      if (h.arc) {
        for (const t of [a0, a0 + arc]) sp.add(outline([[R0 * Math.cos(t), R0 * Math.sin(t)], [R1 * Math.cos(t), R1 * Math.sin(t)]], false, ink));
      }
      // The knob, facing the camera.
      const k = new THREE.Group();
      k.position.x = (R0 + R1) / 2;
      k.add(flatFill(new THREE.CircleGeometry(8, 24)), outline(circlePts(8, 0, Math.PI * 2, 24), true, ink));
      sp.add(k);
      knob = k;
      collider = new THREE.Mesh(new THREE.TorusGeometry((R0 + R1) / 2, 10, 6, 48, arc), new THREE.MeshBasicMaterial({ visible: false }));
      collider.rotation.z = a0;
      sp.add(collider);
    }
    group.traverse((o) => (o.renderOrder = o.userData.role === "outline" ? 21 : 20));
    s.gizmos.add(group);
    s.handleObjects.push({ handle: h, group, collider, knob, spin });
  }
  styleHandles(s);
}

function styleHandles(s: SceneState) {
  // With several handles (the body gizmo) the ones not under the cursor are dimmed.
  const several = s.handleObjects.length > 1;
  for (const ho of s.handleObjects) {
    const hovered = ho.handle.id === s.hoveredHandle;
    const opacity = several && !hovered && !s.dragging ? 0.55 : 1;
    ho.group.traverse((o) => {
      if (o.userData.role === "fill") {
        const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial;
        m.color.set(hovered ? HANDLE_HOVER : 0xffffff);
        m.opacity = opacity;
      } else if (o.userData.role === "outline") {
        ((o as LineSegments2).material as LineMaterial).opacity = opacity;
      }
    });
  }
}

const INK = 0x1d2633;
const HANDLE_HOVER = 0xffe08a;
/** Outline materials of the current handles: their resolution follows the viewport size. */
const HANDLE_LINES: LineMaterial[] = [];
const HANDLE_RES = new THREE.Vector2(1, 1);

/** A 1.75 px outline through 2D points (in the handle's local plane). */
function outline(pts: [number, number][], closed: boolean, color: number): LineSegments2 {
  const pos: number[] = [];
  for (let i = 0; i + 1 < pts.length + (closed ? 1 : 0); i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    pos.push(p[0], p[1], 0, q[0], q[1], 0);
  }
  const geo = new LineSegmentsGeometry();
  geo.setPositions(pos);
  const mat = new LineMaterial({ color, linewidth: 1.75, worldUnits: false, depthTest: false, transparent: true });
  mat.resolution.copy(HANDLE_RES);
  HANDLE_LINES.push(mat);
  const line = new LineSegments2(geo, mat);
  line.userData.role = "outline";
  return line;
}

function circlePts(r: number, a0: number, arc: number, steps: number): [number, number][] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = a0 + (arc * i) / steps;
    return [r * Math.cos(t), r * Math.sin(t)] as [number, number];
  }).slice(0, arc >= Math.PI * 2 - 1e-9 ? steps : steps + 1);
}

/** Ring plane perpendicular to its axis, turned so the knob points at `toward`. */
function orientRing(group: THREE.Object3D, h: Extract<Handle, { kind: "ring" }>) {
  const axis = new THREE.Vector3(...h.axis).normalize();
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
  if (!h.toward) return;
  const want = new THREE.Vector3(...h.toward).projectOnPlane(axis);
  const have = new THREE.Vector3(1, 0, 0).applyQuaternion(group.quaternion);
  if (want.lengthSq() < 1e-12) return;
  const ang = Math.atan2(have.clone().cross(want).dot(axis), have.dot(want.normalize()));
  group.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, ang));
}

/** Arrows turn about their direction to face the camera; ring knobs face it fully. */
function faceCamera(ho: HandleObject, camera: THREE.Camera) {
  if (ho.handle.kind === "arrow") {
    const y = new THREE.Vector3(...ho.handle.dir).normalize();
    const toCam = camera.position.clone().sub(ho.group.position).normalize();
    let x = new THREE.Vector3().crossVectors(y, toCam);
    if (x.lengthSq() < 1e-8) x = new THREE.Vector3().crossVectors(y, Math.abs(y.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0));
    x.normalize();
    const z = new THREE.Vector3().crossVectors(x, y);
    ho.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  } else if (ho.knob) {
    // The knob's parent is the turning part of the ring.
    const parent = ho.group.quaternion.clone();
    if (ho.spin) parent.multiply(ho.spin.quaternion);
    ho.knob.quaternion.copy(parent.invert().multiply(camera.quaternion));
  }
}

function clearGroup(group: THREE.Group) {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof LineSegments2) o.geometry.dispose();
    });
  }
}

// ---- client-side previews --------------------------------------------------------------

/** The moved body's faces and edges in their own group, plus the other bodies' edges. */
function buildRigid(m: MeshData, body: string): { body: string; group: THREE.Group; others: THREE.LineSegments } {
  const idx: number[] = [];
  m.faceGroups.forEach((g, i) => {
    if (m.faceBody[i] === body) for (let t = g.start; t < g.start + g.count; t++) idx.push(m.triangles[t]);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(m.vertices, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
  geo.setIndex(idx);
  const moved: number[] = [], still: number[] = [];
  m.edgeGroups.forEach((g, i) => {
    const out = m.edgeBody[i] === body ? moved : still;
    for (let k = g.start; k < g.start + g.count; k++) out.push(m.edges[k * 3], m.edges[k * 3 + 1], m.edges[k * 3 + 2]);
  });
  const lines = (pts: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineSegments(g, EDGE);
  };
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  group.add(new THREE.Mesh(geo, BODY_SELECTED), lines(moved));
  return { body, group, others: lines(still) };
}

/** Prism swept from a face along its normal: the face's triangles as caps, its boundary as walls. */
function ghostPrism(m: MeshData, face: string, distance: number): THREE.BufferGeometry | null {
  const i = m.faceNames.indexOf(face);
  if (i < 0) return null;
  const g = m.faceGroups[i];
  const v = (j: number) => [m.vertices[j * 3], m.vertices[j * 3 + 1], m.vertices[j * 3 + 2]];
  // Face normal from the mesh normals of its first triangle.
  const j0 = m.triangles[g.start];
  const n = [m.normals[j0 * 3], m.normals[j0 * 3 + 1], m.normals[j0 * 3 + 2]];
  const off = (p: number[]) => [p[0] + n[0] * distance, p[1] + n[1] * distance, p[2] + n[2] * distance];
  const pos: number[] = [];
  // Boundary edges are used by exactly one triangle; vertices are welded by position.
  const key = (j: number) => v(j).map((x) => Math.round(x * 1e4)).join(",");
  const count = new Map<string, { a: number; b: number; n: number }>();
  for (let t = g.start; t < g.start + g.count; t += 3) {
    const tri = [m.triangles[t], m.triangles[t + 1], m.triangles[t + 2]];
    const a = v(tri[0]), b = v(tri[1]), c = v(tri[2]);
    pos.push(...a, ...b, ...c, ...off(a), ...off(b), ...off(c));
    for (let k = 0; k < 3; k++) {
      const x = tri[k], y = tri[(k + 1) % 3];
      const kx = key(x), ky = key(y);
      const id = kx < ky ? `${kx}|${ky}` : `${ky}|${kx}`;
      const e = count.get(id);
      if (e) e.n++;
      else count.set(id, { a: x, b: y, n: 1 });
    }
  }
  for (const e of count.values()) {
    if (e.n !== 1) continue;
    const a = v(e.a), b = v(e.b), a2 = off(a), b2 = off(b);
    pos.push(...a, ...b, ...b2, ...a, ...b2, ...a2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return geo;
}

// ---- view toolbar ------------------------------------------------------------------

const VIEWS: [ViewName, string, string][] = [
  ["top", "Top", "7"],
  ["front", "Front", "1"],
  ["right", "Right", "3"],
  ["iso", "Iso", "0"],
];
const MODE_LABEL: Record<NavMode, string> = { auto: "Auto", mouse: "Mouse", trackpad: "Trackpad" };
const MODE_HINT: Record<NavMode, string> = {
  auto: "Wheel zooms; sideways two-finger scrolls orbit (trackpad), pinch zooms",
  mouse: "Wheel zooms",
  trackpad: "Two fingers orbit, shift + two fingers pan, pinch zooms",
};

function ViewBar({ state }: { state: RefObject<SceneState | null> }) {
  const [mode, setMode] = useState<NavMode>(readNavMode);
  // Section view: off, or the plane's axis, side and position.
  const [section, setSection] = useState<SectionSpec | null>(null);
  const applySection = (spec: SectionSpec | null) => {
    setSection(spec);
    const s = state.current;
    if (!s) return;
    s.sectionSpec = spec;
    s.section.update(spec, s.body, s.box);
  };
  const centreOn = (axis: SectionAxis): SectionSpec => {
    const [lo, hi] = sectionRange(state.current?.box ?? null, axis);
    return { axis, flip: section?.flip ?? false, offset: Math.round(((lo + hi) / 2) * 10) / 10 };
  };
  const range = section ? sectionRange(state.current?.box ?? null, section.axis) : null;
  // The Inspect menu (section, overhangs) is open.
  const [inspect, setInspect] = useState(false);
  // Overhang analysis: limit angle when on, and the area found.
  const [overhang, setOverhang] = useState<number | null>(null);
  const [overhangArea, setOverhangArea] = useState<number | null>(null);
  // The scene is set up after this bar mounts (parent effects run last): hook in when switched on.
  useEffect(
    () => () => {
      if (state.current) state.current.onOverhangs = null;
    },
    [state],
  );
  const applyOverhang = (angle: number | null) => {
    setOverhang(angle);
    const s = state.current;
    if (!s) return;
    s.onOverhangs = setOverhangArea;
    s.overhangAngle = angle;
    refreshOverhangs(s);
  };
  const fit = () => state.current?.nav?.fit(state.current.box);
  const view = (v: ViewName) => state.current?.nav?.view(v, state.current.box);

  useEffect(() => {
    if (state.current?.nav) state.current.nav.mode = mode;
    try {
      localStorage.setItem(NAV_MODE_KEY, mode);
    } catch {
      /* per-viewer preference only */
    }
  }, [mode, state]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector(".sketch-editor")) return; // the sketcher has its own keys
      if (e.key === "f" || e.key === "F") fit();
      if (e.key === "s" || e.key === "S") applySection(section ? null : centreOn("X"));
      const v = VIEWS.find(([, , key]) => key === e.key);
      if (v) view(v[0]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="view-bar">
      <button onClick={fit} title="Fit the model (F)">
        <Icon name="fit" size={15} /> Fit
      </button>
      {VIEWS.map(([v, label, key]) => (
        <button key={v} onClick={() => view(v)} title={`${label} view (${key})`}>
          {label}
        </button>
      ))}
      <span className="inspect-menu">
        <button className={section || overhang !== null ? "active" : ""} onClick={() => setInspect(!inspect)} aria-expanded={inspect} title="Analysis: section view, overhangs">
          <Icon name="inspect" size={15} /> Inspect <span className="tm-caret">▾</span>
        </button>
        {inspect && (
          <span className="inspect-list" role="menu">
            <button role="menuitemcheckbox" aria-checked={!!section} onClick={() => (applySection(section ? null : centreOn("X")), setInspect(false))} title="Cut the model with a plane to see inside">
              <Icon name="section" size={16} /> <span className="tm-label">Section</span>
              {section ? "✓" : <span className="tm-shortcut">S</span>}
            </button>
            <button
              role="menuitemcheckbox"
              aria-checked={overhang !== null}
              onClick={() => (applyOverhang(overhang === null ? 45 : null), setInspect(false))}
              title="3D printing: faces that need support (steeper than the limit, Z up)"
            >
              <Icon name="overhang" size={16} /> <span className="tm-label">Overhangs</span>
              {overhang !== null && "✓"}
            </button>
          </span>
        )}
      </span>
      {overhang !== null && (
        <span className="section-controls">
          <input
            type="number"
            className="overhang-angle"
            aria-label="Overhang limit angle"
            min={10}
            max={89}
            step={5}
            value={overhang}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v >= 10 && v <= 89) applyOverhang(v);
            }}
            title="Steepest overhang the printer handles, degrees from vertical"
          />
          <span className="section-value">°</span>
          <span className={`overhang-area${overhangArea ? " bad" : ""}`} title="Area that needs support">
            {overhangArea ? `${(overhangArea / 100).toFixed(1)} cm²` : "none"}
          </span>
        </span>
      )}
      {section && range && (
        <span className="section-controls">
          {(["X", "Y", "Z"] as const).map((a) => (
            <button key={a} className={section.axis === a ? "active" : ""} onClick={() => applySection(centreOn(a))} title={`Cut across ${a}`}>
              {a}
            </button>
          ))}
          <button onClick={() => applySection({ ...section, flip: !section.flip })} title="Keep the other half">
            ⇄
          </button>
          <input
            type="range"
            aria-label="Section plane position"
            min={range[0]}
            max={range[1]}
            step={Math.max(0.01, (range[1] - range[0]) / 400)}
            value={Math.min(range[1], Math.max(range[0], section.offset))}
            onChange={(e) => applySection({ ...section, offset: Number(e.target.value) })}
            title={`Plane at ${section.axis} = ${section.offset.toFixed(1)} mm`}
          />
          <span className="section-value">{section.offset.toFixed(1)}</span>
        </span>
      )}
      <button
        className="nav-mode"
        title={`Navigation: ${MODE_LABEL[mode]} — ${MODE_HINT[mode]}. Click to change.`}
        onClick={() => setMode(mode === "auto" ? "mouse" : mode === "mouse" ? "trackpad" : "auto")}
      >
        {mode === "trackpad" ? "▭" : mode === "mouse" ? "🖱" : "⟳"} {MODE_LABEL[mode]}
      </button>
    </div>
  );
}

