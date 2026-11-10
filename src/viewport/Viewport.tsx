import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { MeshData, SketchPreview } from "../model/types";

interface Props {
  mesh: MeshData | null;
  sketches: SketchPreview[];
  selectedSketchId: string | null;
  /** Index of the hovered face within the current mesh, or null. */
  onHoverFace: (faceIndex: number | null) => void;
}

const BODY = new THREE.MeshStandardMaterial({ color: 0xb8c4d6, metalness: 0.1, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const HOVER = new THREE.MeshStandardMaterial({ color: 0x4f8cff, metalness: 0.1, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const EDGE = new THREE.LineBasicMaterial({ color: 0x1d2633 });
const SKETCH = new THREE.LineBasicMaterial({ color: 0xff9f1a });
const SKETCH_SEL = new THREE.LineBasicMaterial({ color: 0xff3d71 });

interface SceneState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  model: THREE.Group;
  body: THREE.Mesh | null;
  faceGroups: MeshData["faceGroups"];
  hovered: number | null;
  render: () => void;
}

export function Viewport({ mesh, sketches, selectedSketchId, onHoverFace }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const state = useRef<SceneState | null>(null);
  const hoverCb = useRef(onHoverFace);
  hoverCb.current = onHoverFace;

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
    scene.add(model);

    const s: SceneState = {
      renderer, scene, camera, controls, model,
      body: null, faceGroups: [], hovered: null,
      render: () => renderer.render(scene, camera),
    };
    state.current = s;

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = el;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    // Face hover via raycast -> triangle index -> OCCT face id.
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const onMove = (ev: PointerEvent) => {
      if (!s.body) return;
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObject(s.body)[0];
      let faceId: number | null = null;
      if (hit?.faceIndex != null) {
        const idx = hit.faceIndex * 3;
        faceId = s.faceGroups.find((g) => idx >= g.start && idx < g.start + g.count)?.faceId ?? null;
      }
      if (faceId !== s.hovered) {
        s.hovered = faceId;
        applyHover(s);
        // Report a stable, readable index; the raw faceId is an OCCT hash.
        hoverCb.current(faceId == null ? null : s.faceGroups.findIndex((g) => g.faceId === faceId));
      }
    };
    renderer.domElement.addEventListener("pointermove", onMove);

    let raf = 0;
    const loop = () => {
      controls.update();
      s.render();
      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointermove", onMove);
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
      state.current = null;
    };
  }, []);

  // Rebuild model geometry when the kernel returns a new result.
  useEffect(() => {
    const s = state.current;
    if (!s) return;
    clearGroup(s.model);
    s.body = null;
    s.faceGroups = [];
    s.hovered = null;

    if (mesh) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(mesh.vertices, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
      g.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
      const body = new THREE.Mesh(g, [BODY, HOVER]);
      s.body = body;
      s.faceGroups = mesh.faceGroups;
      applyHover(s);
      s.model.add(body);

      const eg = new THREE.BufferGeometry();
      eg.setAttribute("position", new THREE.BufferAttribute(mesh.edges, 3));
      s.model.add(new THREE.LineSegments(eg, EDGE));
    }

    for (const sk of sketches) {
      const lg = new THREE.BufferGeometry();
      lg.setAttribute("position", new THREE.BufferAttribute(sk.segments, 3));
      s.model.add(new THREE.LineSegments(lg, sk.id === selectedSketchId ? SKETCH_SEL : SKETCH));
    }
  }, [mesh, sketches, selectedSketchId]);

  return <div ref={host} className="viewport" />;
}

function applyHover(s: SceneState) {
  if (!s.body) return;
  const g = s.body.geometry;
  g.clearGroups();
  for (const fg of s.faceGroups) g.addGroup(fg.start, fg.count, fg.faceId === s.hovered ? 1 : 0);
}

function clearGroup(group: THREE.Group) {
  for (const child of [...group.children]) {
    group.remove(child);
    if (child instanceof THREE.Mesh || child instanceof THREE.Line) child.geometry.dispose();
  }
}
