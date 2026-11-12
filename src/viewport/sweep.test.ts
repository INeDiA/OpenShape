import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { SketchPreview } from "../model/types";
import { extrudeSweep, revolveSweep } from "./sweep";

/** A 10 x 5 rectangle at x 10..20 on the XZ plane (sketch y = world Z). */
const sk: SketchPreview = {
  id: "s",
  segments: new Float32Array(),
  frame: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], n: [0, -1, 0] },
  regions: [{ id: "r", outer: new Float32Array([10, 0, 20, 0, 20, 5, 10, 5]), holes: [], inside: [15, 2.5] }],
};

/** Volume enclosed by a triangle soup (divergence theorem), regardless of winding direction. */
function volume(pos: Float32Array): number {
  let v = 0;
  for (let i = 0; i < pos.length; i += 9) {
    const a = new THREE.Vector3(pos[i], pos[i + 1], pos[i + 2]);
    const b = new THREE.Vector3(pos[i + 3], pos[i + 4], pos[i + 5]);
    const c = new THREE.Vector3(pos[i + 6], pos[i + 7], pos[i + 8]);
    v += a.dot(b.clone().cross(c)) / 6;
  }
  return Math.abs(v);
}

const bounds = (pos: Float32Array) => new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(pos, 3));

describe("swept previews", () => {
  it("extrudes a region along the sketch normal", () => {
    const pos = extrudeSweep(sk, ["r"], 8);
    const b = bounds(pos);
    expect(b.min.y).toBeCloseTo(-8);
    expect(b.max.y).toBeCloseTo(0);
    expect(volume(pos)).toBeCloseTo(10 * 5 * 8, 6);
  });

  it("revolves the way positive angles turn in the kernel (right-handed about the axis)", () => {
    // +90 about +Z takes the profile at +X towards +Y, as replicad does.
    const b = bounds(revolveSweep(sk, ["r"], [0, 0, 0], [0, 0, 1], 90));
    expect(b.max.y).toBeCloseTo(20, 1);
    expect(b.min.y).toBeGreaterThan(-1e-6);
    const neg = bounds(revolveSweep(sk, ["r"], [0, 0, 0], [0, 0, 1], -90));
    expect(neg.min.y).toBeCloseTo(-20, 1);
  });

  it("approximates the revolved volume", () => {
    const exact = (Math.PI * (20 * 20 - 10 * 10) * 5) / 4; // a quarter of an annular ring
    expect(Math.abs(volume(revolveSweep(sk, ["r"], [0, 0, 0], [0, 0, 1], 90)) - exact) / exact).toBeLessThan(0.02);
  });
});
