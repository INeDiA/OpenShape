import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { MeshData, SketchPreview } from "../model/types";

export interface HoverInfo {
  face?: string;
  edge?: string;
}

interface Props {
  mesh: MeshData | null;
  sketches: SketchPreview[];
  selectedSketchId: string | null;
  onHover: (info: HoverInfo | null) => void;
  /** What clicks select: edges (fillet/chamfer) or faces (everything else). */
  pickEdges: boolean;
  selectedEdges: string[];
  onPickEdge: (name: string) => void;
  selectedFaces: string[];
  /** Click on a face (null = empty space); `additive` with Shift/Cmd. */
  onPickFace: (name: string | null, additive: boolean) => void;
}

const BODY = new THREE.MeshStandardMaterial({ color: 0xb8c4d6, metalness: 0.1, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const HOVER = new THREE.MeshStandardMaterial({ color: 0x4f8cff, metalness: 0.1, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const SELECTED = new THREE.MeshStandardMaterial({ color: 0xff6b93, metalness: 0.1, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const EDGE = new THREE.LineBasicMaterial({ color: 0x1d2633 });
const SKETCH = new THREE.LineBasicMaterial({ color: 0xff9f1a });
const SKETCH_SEL = new THREE.LineBasicMaterial({ color: 0xff3d71 });
const EDGE_SELECTED = new LineMaterial({ color: 0xff3d71, linewidth: 4, worldUnits: false });
const EDGE_HOVER = new LineMaterial({ color: 0x4f8cff, linewidth: 4, worldUnits: false });

interface SceneState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  model: THREE.Group;
  overlay: THREE.Group;
  body: THREE.Mesh | null;
  edgeLines: THREE.LineSegments | null;
  mesh: MeshData | null;
  hoveredFace: number | null;
  hoveredEdge: number | null;
  selectedFaces: Set<string>;
}

export function Viewport({ mesh, sketches, selectedSketchId, onHover, pickEdges, selectedEdges, onPickEdge, selectedFaces, onPickFace }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const state = useRef<SceneState | null>(null);
  // Latest props for the event handlers registered once.
  const props = useRef({ onHover, pickEdges, onPickEdge, selectedEdges, onPickFace });
  props.current = { onHover, pickEdges, onPickEdge, selectedEdges, onPickFace };

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
    const overlay = new THREE.Group();
    scene.add(model, overlay);

    const s: SceneState = { renderer, scene, camera, controls, model, overlay, body: null, edgeLines: null, mesh: null, hoveredFace: null, hoveredEdge: null, selectedFaces: new Set() };
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
    const setRay = (ev: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      // ~6 px pick tolerance for edges, in world units at the target distance.
      const dist = camera.position.distanceTo(controls.target);
      ray.params.Line = { threshold: (dist * Math.tan((camera.fov * Math.PI) / 360) * 2 * 6) / r.height };
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

    const onMove = (ev: PointerEvent) => {
      if (!s.mesh || ev.buttons) return;
      setRay(ev);
      const edge = props.current.pickEdges ? pickEdge() : null;
      const face = edge == null ? pickFace() : null;
      if (edge !== s.hoveredEdge || face !== s.hoveredFace) {
        s.hoveredEdge = edge;
        s.hoveredFace = props.current.pickEdges ? null : face;
        applyFaceHover(s);
        rebuildOverlay(s, props.current.selectedEdges);
        const m = s.mesh;
        props.current.onHover(edge != null ? { edge: m.edgeNames[edge] } : face != null ? { face: m.faceNames[face] } : null);
      }
    };

    // Distinguish a click from an orbit drag.
    let down: { x: number; y: number } | null = null;
    const onDown = (ev: PointerEvent) => (down = { x: ev.clientX, y: ev.clientY });
    const onUp = (ev: PointerEvent) => {
      const d = down;
      down = null;
      if (!d || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 4 || ev.button !== 0) return;
      setRay(ev);
      if (props.current.pickEdges) {
        const edge = s.mesh ? pickEdge() : null;
        if (edge != null) props.current.onPickEdge(s.mesh!.edgeNames[edge]);
        return;
      }
      const face = s.mesh ? pickFace() : null;
      props.current.onPickFace(face != null ? s.mesh!.faceNames[face] : null, ev.shiftKey || ev.metaKey);
    };
    const onLeave = () => {
      s.hoveredEdge = s.hoveredFace = null;
      applyFaceHover(s);
      rebuildOverlay(s, props.current.selectedEdges);
      props.current.onHover(null);
    };
    const canvas = renderer.domElement;
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onLeave);

    let raf = 0;
    const loop = () => {
      controls.update();
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
      s.body = new THREE.Mesh(g, [BODY, HOVER, SELECTED]);
      applyFaceHover(s);
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
    // selectedEdges handled by the effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mesh, sketches, selectedSketchId]);

  useEffect(() => {
    if (state.current) rebuildOverlay(state.current, selectedEdges);
  }, [selectedEdges, pickEdges]);

  useEffect(() => {
    const s = state.current;
    if (!s) return;
    s.selectedFaces = new Set(selectedFaces);
    applyFaceHover(s);
  }, [selectedFaces, mesh]);

  return <div ref={host} className={`viewport${pickEdges ? " picking" : ""}`} />;
}

function applyFaceHover(s: SceneState) {
  if (!s.body || !s.mesh) return;
  const g = s.body.geometry;
  g.clearGroups();
  s.mesh.faceGroups.forEach((fg, i) => g.addGroup(fg.start, fg.count, i === s.hoveredFace ? 1 : s.selectedFaces.has(s.mesh!.faceNames[i]) ? 2 : 0));
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

function clearGroup(group: THREE.Group) {
  for (const child of [...group.children]) {
    group.remove(child);
    if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof LineSegments2) child.geometry.dispose();
  }
}
