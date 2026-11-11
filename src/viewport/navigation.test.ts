import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CameraNav } from "./navigation";

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
