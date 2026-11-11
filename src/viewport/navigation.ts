// Camera navigation on top of OrbitControls: fit to model, animated standard
// views, zoom towards the cursor, and trackpad gestures.
//
// Wheel input:   pinch (ctrl+wheel) or mouse wheel  -> zoom at cursor
//                two-finger scroll (trackpad)        -> orbit
//                shift + two-finger scroll           -> pan
// Mouse drag (OrbitControls): left orbit, right/middle pan.

import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export type ViewName = "top" | "front" | "right" | "iso";
export type NavMode = "auto" | "mouse" | "trackpad";

/** Direction from the target towards the camera, Z up. Top is tilted a hair to keep "up" defined. */
const VIEW_DIRS: Record<ViewName, THREE.Vector3> = {
  top: new THREE.Vector3(0, -0.0001, 1),
  front: new THREE.Vector3(0, -1, 0),
  right: new THREE.Vector3(1, 0, 0),
  iso: new THREE.Vector3(1, -1, 0.85),
};

interface Tween {
  fromPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toPos: THREE.Vector3;
  toTarget: THREE.Vector3;
  start: number;
  duration: number;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class CameraNav {
  private tween: Tween | null = null;
  mode: NavMode = "auto";

  constructor(
    private camera: THREE.PerspectiveCamera,
    private controls: OrbitControls,
    private dom: HTMLElement,
    /** World point under the cursor (model hit), or null to use the target plane. */
    private pickPoint: (clientX: number, clientY: number) => THREE.Vector3 | null,
  ) {
    controls.enableZoom = false; // wheel handled here
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    controls.addEventListener("start", () => (this.tween = null));
  }

  // ---- animation -------------------------------------------------------------

  /** Call every frame; returns true while animating. */
  update(now: number): boolean {
    const t = this.tween;
    if (!t) return false;
    const k = Math.min(1, (now - t.start) / t.duration);
    const e = ease(k);
    this.camera.position.lerpVectors(t.fromPos, t.toPos, e);
    this.controls.target.lerpVectors(t.fromTarget, t.toTarget, e);
    this.camera.lookAt(this.controls.target);
    if (k >= 1) this.tween = null;
    return true;
  }

  private animateTo(pos: THREE.Vector3, target: THREE.Vector3, duration = 320) {
    this.tween = { fromPos: this.camera.position.clone(), fromTarget: this.controls.target.clone(), toPos: pos, toTarget: target, start: performance.now(), duration };
  }

  // ---- fit & views ---------------------------------------------------------------

  /** Distance at which a sphere of `radius` fills the view (both directions). */
  private fitDistance(radius: number) {
    const vfov = (this.camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    return (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.08;
  }

  /** Frames `box`, keeping the current view direction unless `dir` is given. */
  fit(box: THREE.Box3 | null, dir?: THREE.Vector3, animate = true) {
    const center = new THREE.Vector3(), size = new THREE.Vector3();
    if (box && !box.isEmpty()) {
      box.getCenter(center);
      box.getSize(size);
    } else size.set(80, 80, 40);
    const radius = Math.max(size.length() / 2, 5);
    const d = (dir ?? this.camera.position.clone().sub(this.controls.target)).clone().normalize();
    const pos = center.clone().add(d.multiplyScalar(this.fitDistance(radius)));
    if (animate) this.animateTo(pos, center);
    else {
      this.camera.position.copy(pos);
      this.controls.target.copy(center);
      this.camera.lookAt(center);
    }
  }

  view(name: ViewName, box: THREE.Box3 | null) {
    this.fit(box, VIEW_DIRS[name]);
  }

  // ---- wheel ------------------------------------------------------------------

  /** Interprets a wheel event; returns false when it should be left alone. */
  wheel(ev: WheelEvent): boolean {
    this.tween = null;
    const trackpadLike = ev.deltaMode === 0 && (ev.deltaX !== 0 || !Number.isInteger(ev.deltaY) || Math.abs(ev.deltaY) < 40);
    const scrollIsOrbit = this.mode === "trackpad" || (this.mode === "auto" && trackpadLike);
    if (ev.ctrlKey) {
      // Pinch on a trackpad (browsers report it as ctrl+wheel).
      this.zoomAt(Math.exp(ev.deltaY * 0.01), ev.clientX, ev.clientY);
    } else if (scrollIsOrbit) {
      if (ev.shiftKey) this.pan(ev.deltaX, ev.deltaY);
      else this.orbit(ev.deltaX, ev.deltaY);
    } else {
      // Mouse wheel: zoom (line-based deltas are scaled up).
      const dy = ev.deltaMode === 1 ? ev.deltaY * 33 : ev.deltaY;
      this.zoomAt(Math.exp(dy * 0.0015), ev.clientX, ev.clientY);
    }
    return true;
  }

  /** Scales the camera distance around the point under the cursor (factor < 1 zooms in). */
  zoomAt(factor: number, clientX: number, clientY: number) {
    const cam = this.camera, target = this.controls.target;
    const dist = cam.position.distanceTo(target);
    const next = THREE.MathUtils.clamp(dist * factor, 0.5, 20000);
    factor = next / dist;
    const p = this.pickPoint(clientX, clientY) ?? this.pointOnTargetPlane(clientX, clientY) ?? target.clone();
    cam.position.sub(p).multiplyScalar(factor).add(p);
    target.sub(p).multiplyScalar(factor).add(p);
    cam.lookAt(target);
  }

  orbit(dx: number, dy: number) {
    const cam = this.camera, target = this.controls.target;
    const offset = cam.position.clone().sub(target);
    const speed = 0.006;
    // Around world Z (yaw), then around the camera's right axis (pitch), without flipping over the poles.
    offset.applyAxisAngle(new THREE.Vector3(0, 0, 1), -dx * speed);
    const right = new THREE.Vector3().crossVectors(cam.up, offset).normalize();
    const pitched = offset.clone().applyAxisAngle(right, dy * speed);
    const polar = pitched.angleTo(new THREE.Vector3(0, 0, 1));
    if (polar > 0.01 && polar < Math.PI - 0.01) offset.copy(pitched);
    cam.position.copy(target).add(offset);
    cam.lookAt(target);
  }

  pan(dx: number, dy: number) {
    const cam = this.camera, target = this.controls.target;
    const dist = cam.position.distanceTo(target);
    const h = this.dom.clientHeight || 1;
    const perPixel = (2 * dist * Math.tan((cam.fov * Math.PI) / 360)) / h;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 1);
    const move = right.multiplyScalar(dx * perPixel).add(up.multiplyScalar(-dy * perPixel));
    cam.position.add(move);
    target.add(move);
  }

  private pointOnTargetPlane(clientX: number, clientY: number): THREE.Vector3 | null {
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const normal = this.camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, this.controls.target);
    return ray.ray.intersectPlane(plane, new THREE.Vector3());
  }
}
