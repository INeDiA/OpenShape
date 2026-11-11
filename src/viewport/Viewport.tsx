import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { MeshData, SketchPreview } from "../model/types";
import type { Vec3 } from "../model/frame";
import { CameraNav, type NavMode, type ViewName } from "./navigation";

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
}

/** On-model manipulators. Arrows report a signed distance, rings an angle in degrees. */
export type Handle =
  | { id: string; kind: "arrow"; origin: Vec3; dir: Vec3; color: number }
  | { id: string; kind: "ring"; center: Vec3; axis: Vec3; color: number };

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
  /** Changing this number re-frames the model (new/opened document). */
  fitKey: number;
}

const mat = (color: number) => new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const BODY = mat(0xb8c4d6);
const HOVER = mat(0x4f8cff);
const SELECTED = mat(0xff6b93);
const BODY_SELECTED = mat(0xc9d8f2);
const EDGE = new THREE.LineBasicMaterial({ color: 0x1d2633 });
const SKETCH = new THREE.LineBasicMaterial({ color: 0xff9f1a });
const SKETCH_SEL = new THREE.LineBasicMaterial({ color: 0xff3d71 });
const EDGE_SELECTED = new LineMaterial({ color: 0xff3d71, linewidth: 4, worldUnits: false });
const EDGE_HOVER = new LineMaterial({ color: 0x4f8cff, linewidth: 4, worldUnits: false });
const HIDDEN = new THREE.MeshBasicMaterial({ visible: false });
const GHOST_ADD = new THREE.MeshBasicMaterial({ color: 0x4f8cff, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
const GHOST_CUT = new THREE.MeshBasicMaterial({ color: 0xff3d71, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });

interface HandleObject {
  handle: Handle;
  group: THREE.Group;
  collider: THREE.Object3D;
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
  rigid: { body: string; group: THREE.Group; others: THREE.LineSegments } | null;
  ghost: THREE.Mesh | null;
  dragging: boolean;
  nav: CameraNav | null;
  /** Bounds of the current mesh, for fit and standard views. */
  box: THREE.Box3 | null;
  fitted: boolean;
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
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
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
    scene.add(model, overlayGroup, gizmos);

    const s: SceneState = {
      renderer, scene, camera, controls, model, overlay: overlayGroup, gizmos, handleObjects: [],
      body: null, edgeLines: null, mesh: null, hoveredFace: null, hoveredEdge: null, hoveredHandle: null,
      selectedFaces: new Set(), selectedBody: null, hiddenBody: null, rigid: null, ghost: null, dragging: false, nav: null, box: null, fitted: false,
    };
    state.current = s;

    // Navigation: zoom towards the model point under the cursor.
    const pickRay = new THREE.Raycaster();
    const nav = new CameraNav(camera, controls, renderer.domElement, (cx, cy) => {
      if (!s.body) return null;
      const r = renderer.domElement.getBoundingClientRect();
      pickRay.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
      return pickRay.intersectObject(s.body)[0]?.point ?? null;
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
      const bodyHit = s.body ? ray.intersectObject(s.body)[0] : undefined;
      // Pixel tolerance measured where the cursor actually is (not at the orbit target),
      // and tighter over fillet faces so thin blends stay selectable.
      const r = renderer.domElement.getBoundingClientRect();
      const dist = bodyHit?.distance ?? camera.position.distanceTo(controls.target);
      let px = 6;
      if (bodyHit?.faceIndex != null) {
        const idx = bodyHit.faceIndex * 3;
        const fi = s.mesh.faceGroups.findIndex((g) => idx >= g.start && idx < g.start + g.count);
        if (fi >= 0 && s.mesh.faceNames[fi].includes(":blend:")) px = 2;
      }
      ray.params.Line = { threshold: (dist * Math.tan((camera.fov * Math.PI) / 360) * 2 * px) / r.height };
      const hit = ray.intersectObject(s.edgeLines)[0];
      if (!hit || hit.index == null) return null;
      if (bodyHit && bodyHit.distance < hit.distance - 0.5) return null; // occluded
      const i = s.mesh.edgeGroups.findIndex((g) => hit.index! >= g.start && hit.index! < g.start + g.count);
      return i < 0 ? null : i;
    };

    const pickFace = (): number | null => {
      if (!s.body || !s.mesh) return null;
      const hit = ray.intersectObject(s.body)[0];
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
        if (drag.h.handle.kind === "ring") value = ((value + 540) % 360) - 180;
        drag.last = value;
        latest.current.onHandleDrag(drag.h.handle.id, value, "move");
        return;
      }
      if (ev.buttons) return;
      const h = pickHandle();
      const hid = h?.handle.id ?? null;
      if (hid !== s.hoveredHandle) {
        s.hoveredHandle = hid;
        renderer.domElement.style.cursor = hid ? "grab" : "";
        styleHandles(s);
      }
      if (h || !s.mesh) return;
      const edge = pickEdge();
      const face = edge == null && !latest.current.edgesOnly ? pickFace() : null;
      if (edge !== s.hoveredEdge || face !== s.hoveredFace) {
        s.hoveredEdge = edge;
        s.hoveredFace = face;
        applyFaceMaterials(s);
        rebuildOverlay(s, latest.current.selectedEdges);
        const m = s.mesh;
        latest.current.onHover(edge != null ? { edge: m.edgeNames[edge] } : face != null ? { face: m.faceNames[face] } : null);
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
      if (!d || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 4 || ev.button !== 0 || !s.mesh) return;
      setRay(ev);
      const additive = ev.shiftKey || ev.metaKey;
      const edge = pickEdge();
      if (edge != null) return latest.current.onPickEdge(s.mesh.edgeNames[edge], additive);
      if (latest.current.edgesOnly) return;
      const face = pickFace();
      latest.current.onPickFace(face != null ? s.mesh.faceNames[face] : null, additive);
    };
    const onDbl = (ev: MouseEvent) => {
      if (!s.mesh) return;
      setRay(ev);
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
    const loop = () => {
      nav.update(performance.now());
      controls.update();
      // Keep depth precision reasonable at any zoom.
      const d = camera.position.distanceTo(controls.target);
      camera.near = Math.max(0.01, d / 2000);
      camera.far = Math.max(1000, d * 50);
      camera.updateProjectionMatrix();
      // Handles keep a constant on-screen size.
      for (const ho of s.handleObjects) {
        const anchor = ho.handle.kind === "arrow" ? ho.handle.origin : ho.handle.center;
        const dist = camera.position.distanceTo(tmp.set(...anchor));
        ho.group.scale.setScalar(dist * 0.012);
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

    for (const sk of sketches) {
      const lg = new THREE.BufferGeometry();
      lg.setAttribute("position", new THREE.BufferAttribute(sk.segments, 3));
      s.model.add(new THREE.LineSegments(lg, sk.id === selectedSketchId ? SKETCH_SEL : SKETCH));
    }
    rebuildOverlay(s, selectedEdges);
    // selectedEdges handled by its own effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mesh, sketches, selectedSketchId]);

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

function applyFaceMaterials(s: SceneState) {
  if (!s.body || !s.mesh) return;
  const g = s.body.geometry;
  g.clearGroups();
  s.mesh.faceGroups.forEach((fg, i) => {
    const m = s.mesh!;
    const idx =
      s.hiddenBody && m.faceBody[i] === s.hiddenBody ? 4 : i === s.hoveredFace ? 1 : s.selectedFaces.has(m.faceNames[i]) ? 2 : s.selectedBody && m.faceBody[i] === s.selectedBody ? 3 : 0;
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
      if (h.kind === "arrow") ho.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...h.dir).normalize());
      if (h.color !== ho.handle.color) ho.group.traverse((o) => o instanceof THREE.Mesh && (o.material as THREE.MeshBasicMaterial).visible && (o.material as THREE.MeshBasicMaterial).color.set(h.color));
      // During a drag keep the original geometry: the drag measures from it.
      ho.handle = s.dragging ? { ...ho.handle, color: h.color } : h;
    });
    return;
  }
  clearGroup(s.gizmos);
  s.handleObjects = [];
  for (const h of handles) {
    const group = new THREE.Group();
    const color = new THREE.MeshBasicMaterial({ color: h.color, depthTest: false, transparent: true, opacity: 0.95 });
    let collider: THREE.Object3D;
    if (h.kind === "arrow") {
      group.position.set(...h.origin);
      group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...h.dir).normalize());
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 7, 12), color);
      shaft.position.y = 3.5;
      const tip = new THREE.Mesh(new THREE.ConeGeometry(1.4, 3.2, 20), color);
      tip.position.y = 8.6;
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 12), color);
      // Generous invisible collider so the handle is easy to grab.
      collider = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 11, 8), new THREE.MeshBasicMaterial({ visible: false }));
      collider.position.y = 5;
      group.add(shaft, tip, ball, collider);
    } else {
      group.position.set(...h.center);
      group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...h.axis).normalize());
      const ring = new THREE.Mesh(new THREE.TorusGeometry(11, 0.35, 8, 64), color);
      const knob = new THREE.Mesh(new THREE.SphereGeometry(1.1, 16, 12), color);
      knob.position.x = 11;
      collider = new THREE.Mesh(new THREE.TorusGeometry(11, 2, 6, 48), new THREE.MeshBasicMaterial({ visible: false }));
      group.add(ring, knob, collider);
    }
    group.traverse((o) => (o.renderOrder = 20));
    s.gizmos.add(group);
    s.handleObjects.push({ handle: h, group, collider });
  }
  styleHandles(s);
}

function styleHandles(s: SceneState) {
  for (const ho of s.handleObjects) {
    const hovered = ho.handle.id === s.hoveredHandle;
    ho.group.traverse((o) => {
      if (o instanceof THREE.Mesh && (o.material as THREE.MeshBasicMaterial).visible) {
        (o.material as THREE.MeshBasicMaterial).color.set(hovered ? 0xffc53d : ho.handle.color);
      }
    });
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
  auto: "Detects mouse or trackpad from the scroll gesture",
  mouse: "Wheel zooms",
  trackpad: "Two fingers orbit, shift + two fingers pan, pinch zooms",
};

function ViewBar({ state }: { state: RefObject<SceneState | null> }) {
  const [mode, setMode] = useState<NavMode>(readNavMode);
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
      const v = VIEWS.find(([, , key]) => key === e.key);
      if (v) view(v[0]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="view-bar">
      <button onClick={fit} title="Fit the model (F)">⤢ Fit</button>
      {VIEWS.map(([v, label, key]) => (
        <button key={v} onClick={() => view(v)} title={`${label} view (${key})`}>
          {label}
        </button>
      ))}
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
