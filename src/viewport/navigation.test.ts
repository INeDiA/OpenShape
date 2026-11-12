import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CameraNav, placeSketchCamera } from "./navigation";

// Minimal stand-ins: the math only needs a target and a dom size.
function setup(pick: THREE.Vector3 | null = null) {
  const camera = new THREE.PerspectiveCamera(40, 1.5, 0.1, 10000);
  camera.up.set(0, 0, 1);
  camera.position.set(90, -110, 80);
  const controls = {
    target: new THREE.Vector3(),
    enableZoom: true,
    mouseButtons: {},
    addEventListener: () => {},
  } as unknown as ConstructorParameters<typeof CameraNav>[1];
  const dom = { clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 600 }) } as unknown as HTMLElement;
  const nav = new CameraNav(camera, controls, dom, () => pick?.clone() ?? null);
  camera.lookAt(controls.target);
  camera.updateMatrixWorld();
  return { camera, controls, nav };
}

describe("camera navigation", () => {
  it("fits a box: centred and fully visible", () => {
    const { camera, controls, nav } = setup();
    const box = new THREE.Box3(new THREE.Vector3(100, 0, 0), new THREE.Vector3(140, 30, 20));
    nav.fit(box, undefined, false);
    expect(controls.target.toArray()).toEqual([120, 15, 10]);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    // Every corner projects inside the viewport.
    for (const x of [100, 140]) for (const y of [0, 30]) for (const z of [0, 20]) {
      const p = new THREE.Vector3(x, y, z).project(camera);
      expect(Math.abs(p.x)).toBeLessThan(1);
      expect(Math.abs(p.y)).toBeLessThan(1);
    }
  });

  it("goes to standard views", () => {
    const { camera, controls, nav } = setup();
    const box = new THREE.Box3(new THREE.Vector3(-20, -15, 0), new THREE.Vector3(20, 15, 20));
    nav.view("top", box);
    nav.update(performance.now() + 1000); // finish the animation
    const dir = camera.position.clone().sub(controls.target).normalize();
    expect(dir.z).toBeGreaterThan(0.999);
    nav.view("front", box);
    nav.update(performance.now() + 1000);
    expect(camera.position.clone().sub(controls.target).normalize().y).toBeCloseTo(-1);
  });

  it("zooms towards the point under the cursor and keeps it in place", () => {
    const point = new THREE.Vector3(10, 5, 3);
    const { camera, controls, nav } = setup(point);
    const before = point.clone().sub(camera.position).normalize();
    const dist = camera.position.distanceTo(controls.target);
    nav.zoomAt(0.5, 450, 300);
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(dist * 0.5);
    // The picked point stays on the same line of sight.
    expect(point.clone().sub(camera.position).normalize().dot(before)).toBeCloseTo(1);
  });

  it("orbits without flipping over the poles", () => {
    const { camera, controls, nav } = setup();
    for (let i = 0; i < 200; i++) nav.orbit(0, -50); // keep pitching up
    const polar = camera.position.clone().sub(controls.target).angleTo(new THREE.Vector3(0, 0, 1));
    expect(polar).toBeGreaterThan(0.005);
  });
});

describe("sketch camera", () => {
  it("maps plane coordinates to the screen at the editor's scale", () => {
    const camera = new THREE.PerspectiveCamera(40, 1.5, 0.1, 10000);
    camera.updateProjectionMatrix();
    const target = new THREE.Vector3();
    // Front plane (XZ): local x = world X, local y = world Z, normal towards the viewer (-Y).
    const frame = { origin: [0, 0, 5] as [number, number, number], x: [1, 0, 0] as [number, number, number], y: [0, 0, 1] as [number, number, number], n: [0, -1, 0] as [number, number, number] };
    const h = 600, w = 900, scale = 4;
    placeSketchCamera(camera, target, { frame, cx: 10, cy: 2, scale }, h);
    camera.updateMatrixWorld();
    // Plane point (cx + 25, cy + 10) should be 25*scale px right and 10*scale px up of center.
    const p = new THREE.Vector3(10 + 25, 0, 5 + 2 + 10).project(camera);
    expect(((p.x + 1) / 2) * w - w / 2).toBeCloseTo(25 * scale, 6);
    // Screen y grows downwards: 10 mm up is 40 px above the center.
    expect(((1 - p.y) / 2) * h - h / 2).toBeCloseTo(-10 * scale, 6);
  });
});

describe("wheel in auto mode", () => {
  const wheel = (o: Partial<WheelEvent>) => ({ deltaMode: 0, deltaX: 0, deltaY: 0, ctrlKey: false, shiftKey: false, clientX: 450, clientY: 300, timeStamp: 0, ...o }) as WheelEvent;

  it("zooms with a smooth-scrolling mouse (small, fractional vertical deltas)", () => {
    const { camera, controls, nav } = setup();
    const d0 = camera.position.distanceTo(controls.target);
    const dir0 = camera.position.clone().sub(controls.target).normalize();
    for (let i = 0; i < 10; i++) nav.wheel(wheel({ deltaY: 3.75, timeStamp: i * 16 }));
    expect(camera.position.distanceTo(controls.target)).toBeGreaterThan(d0);
    // Pure zoom: the view direction doesn't change.
    expect(camera.position.clone().sub(controls.target).normalize().dot(dir0)).toBeCloseTo(1, 6);
  });

  it("keeps zooming when a mouse lets a little sideways motion through", () => {
    // Recorded from a touch-surface mouse: dx 3 next to dy -12, in the middle of a scroll.
    const { camera, controls, nav } = setup();
    const dir0 = camera.position.clone().sub(controls.target).normalize();
    const d0 = camera.position.distanceTo(controls.target);
    nav.wheel(wheel({ deltaY: -14, timeStamp: 0 }));
    nav.wheel(wheel({ deltaX: 3, deltaY: -12, timeStamp: 16 }));
    nav.wheel(wheel({ deltaX: 3, deltaY: -13, timeStamp: 32 }));
    nav.wheel(wheel({ deltaY: -14, timeStamp: 48 }));
    expect(camera.position.distanceTo(controls.target)).toBeLessThan(d0 * 0.95);
    expect(camera.position.clone().sub(controls.target).normalize().dot(dir0)).toBeCloseTo(1, 6);
  });

  it("zooms out around the orbit center, not the cursor", () => {
    const point = new THREE.Vector3(18, -15, 18); // on the model, off center
    const { controls, nav } = setup(point);
    const t0 = controls.target.clone();
    for (let i = 0; i < 20; i++) nav.zoomAt(1.1, 700, 500);
    expect(controls.target.distanceTo(t0)).toBeLessThan(1e-9);
  });

  it("orbits once a gesture moves sideways, until the gesture ends", () => {
    const { camera, controls, nav } = setup();
    const dir0 = camera.position.clone().sub(controls.target).normalize();
    nav.wheel(wheel({ deltaX: 6, deltaY: 1, timeStamp: 0 }));
    nav.wheel(wheel({ deltaY: 4, timeStamp: 16 })); // same gesture, vertical only: still orbit
    const d1 = camera.position.distanceTo(controls.target);
    expect(camera.position.clone().sub(controls.target).normalize().dot(dir0)).toBeLessThan(0.9999);
    nav.wheel(wheel({ deltaY: 4, timeStamp: 1000 })); // new gesture, vertical: zoom
    expect(camera.position.distanceTo(controls.target)).not.toBeCloseTo(d1, 3);
  });
});
