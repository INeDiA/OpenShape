import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { SectionView, sectionPlane, sectionRange } from "./section";

describe("section plane", () => {
  it("keeps the half away from the standard iso viewer, or the other with flip", () => {
    const x = sectionPlane({ axis: "X", flip: false, offset: 5 });
    expect(x.distanceToPoint(new THREE.Vector3(0, 0, 0))).toBeGreaterThan(0); // x < 5 kept
    expect(x.distanceToPoint(new THREE.Vector3(10, 0, 0))).toBeLessThan(0);
    expect(x.distanceToPoint(new THREE.Vector3(5, 3, 7))).toBeCloseTo(0, 9);
    const y = sectionPlane({ axis: "Y", flip: false, offset: -2 });
    expect(y.distanceToPoint(new THREE.Vector3(0, 0, 0))).toBeGreaterThan(0); // y > -2 kept
    const z = sectionPlane({ axis: "Z", flip: true, offset: 10 });
    expect(z.distanceToPoint(new THREE.Vector3(0, 0, 20))).toBeGreaterThan(0); // flipped: z > 10 kept
    expect(z.distanceToPoint(new THREE.Vector3(0, 0, 0))).toBeLessThan(0);
  });

  it("spans the model's bounds along the axis", () => {
    const box = new THREE.Box3(new THREE.Vector3(-20, -15, 0), new THREE.Vector3(20, 15, 20));
    expect(sectionRange(box, "Y")).toEqual([-15, 15]);
    expect(sectionRange(box, "Z")).toEqual([0, 20]);
  });

  it("clips the model materials and adds a cap on the plane", () => {
    const body = new THREE.MeshStandardMaterial(), edges = new THREE.LineBasicMaterial();
    const view = new SectionView([body, edges]);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(40, 30, 20), body);
    const box = new THREE.Box3(new THREE.Vector3(-20, -15, -10), new THREE.Vector3(20, 15, 10));
    view.update({ axis: "X", flip: false, offset: 4 }, mesh, box);
    expect(body.clippingPlanes).toHaveLength(1);
    expect(edges.clippingPlanes).toHaveLength(1);
    const cap = view.group.children.find((c) => c instanceof THREE.Mesh && c.geometry instanceof THREE.PlaneGeometry) as THREE.Mesh;
    expect(cap.position.x).toBeCloseTo(4, 9);
    // Picking ignores the removed half.
    expect(view.keeps(new THREE.Vector3(10, 0, 0))).toBe(false);
    expect(view.keeps(new THREE.Vector3(-10, 0, 0))).toBe(true);
    view.update(null, mesh, box);
    expect(body.clippingPlanes).toHaveLength(0);
    expect(view.group.children).toHaveLength(0);
    expect(view.keeps(new THREE.Vector3(10, 0, 0))).toBe(true);
  });
});
