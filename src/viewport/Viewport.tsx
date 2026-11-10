import { useEffect, useRef, type ReactNode } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { MeshData, SketchPreview } from "../model/types";
import type { Vec3 } from "../model/frame";

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
}

export function Viewport(props: Props) {
  const { mesh, sketches, selectedSketchId, selectedEdges, selectedFaces, selectedBody, handles, overlay } = props;
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
      selectedFaces: new Set(), selectedBody: null,
    };
    state.current = s;

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
      const hit = ray.intersectObject(s.edgeLines)[0];
      if (!hit || hit.index == null) return null;
      const bodyHit = s.body ? ray.intersectObject(s.body)[0] : undefined;
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
      controls.enabled = false;
      renderer.domElement.setPointerCapture(ev.pointerId);
      renderer.domElement.style.cursor = "grabbing";
      latest.current.onHandleDrag(h.handle.id, 0, "start");
    };
    const onUp = (ev: PointerEvent) => {
      if (drag) {
        const d = drag;
        drag = null;
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

    const tmp = new THREE.Vector3();
    let raf = 0;
    const loop = () => {
      controls.update();
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
    s.hoveredFace = s.hoveredEdge = null;

    if (mesh) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(mesh.vertices, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
      g.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
      s.body = new THREE.Mesh(g, [BODY, HOVER, SELECTED, BODY_SELECTED]);
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

  return (
    <div className="viewport-wrap">
      <div ref={host} className={`viewport${props.edgesOnly ? " picking" : ""}`} />
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
    const idx = i === s.hoveredFace ? 1 : s.selectedFaces.has(m.faceNames[i]) ? 2 : s.selectedBody && m.faceBody[i] === s.selectedBody ? 3 : 0;
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
