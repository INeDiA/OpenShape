// Live section view: a clipping plane through the model, with the cut filled
// by a solid cap. The cap uses the stencil trick: drawing the clipped body's
// back faces (+1) and front faces (-1) leaves a non-zero stencil exactly
// where the plane is inside material, and the cap is drawn only there.

import * as THREE from "three";

export type SectionAxis = "X" | "Y" | "Z";

export interface SectionSpec {
  axis: SectionAxis;
  /** Keep the other side. */
  flip: boolean;
  /** Plane position along the axis (mm). */
  offset: number;
}

/**
 * Plane that keeps the half facing the default camera's cut: x ≤ offset,
 * y ≥ offset, z ≤ offset (the removed half is the one towards the viewer of
 * the standard iso view); `flip` keeps the other half. Three.js clips points
 * whose signed distance to the plane is negative.
 */
export function sectionPlane(spec: SectionSpec): THREE.Plane {
  const n = spec.axis === "X" ? new THREE.Vector3(-1, 0, 0) : spec.axis === "Y" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1);
  if (spec.flip) n.negate();
  // n·p + c = 0 on the plane, where the axis coordinate equals offset.
  const along = spec.axis === "X" ? 0 : spec.axis === "Y" ? 1 : 2;
  const c = -n.getComponent(along) * spec.offset;
  return new THREE.Plane(n, c);
}

/** Range of the axis over the box, for the offset slider. */
export function sectionRange(box: THREE.Box3 | null, axis: SectionAxis): [number, number] {
  if (!box || box.isEmpty()) return [-50, 50];
  const k = axis === "X" ? "x" : axis === "Y" ? "y" : "z";
  return [box.min[k], box.max[k]];
}

const CAP = new THREE.MeshStandardMaterial({
  color: 0xe8975a,
  metalness: 0.05,
  roughness: 0.7,
  side: THREE.DoubleSide,
  stencilWrite: true,
  stencilRef: 0,
  stencilFunc: THREE.NotEqualStencilFunc,
  stencilFail: THREE.ReplaceStencilOp,
  stencilZFail: THREE.ReplaceStencilOp,
  stencilZPass: THREE.ReplaceStencilOp,
});

const stencilMaterial = (side: THREE.Side, op: THREE.StencilOp) =>
  new THREE.MeshBasicMaterial({
    side,
    depthWrite: false,
    depthTest: false,
    colorWrite: false,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilFail: op,
    stencilZFail: op,
    stencilZPass: op,
  });
const BACK = stencilMaterial(THREE.BackSide, THREE.IncrementWrapStencilOp);
const FRONT = stencilMaterial(THREE.FrontSide, THREE.DecrementWrapStencilOp);

export class SectionView {
  readonly group = new THREE.Group();
  plane: THREE.Plane | null = null;

  /** `clipped`: materials of the model (faces, edges) that the plane cuts. */
  constructor(private clipped: THREE.Material[]) {}

  /** Applies `spec` (null: no section) to the current body mesh. */
  update(spec: SectionSpec | null, body: THREE.Mesh | null, box: THREE.Box3 | null) {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      if (c instanceof THREE.Mesh && c.geometry !== body?.geometry) c.geometry.dispose();
    }
    this.plane = spec ? sectionPlane(spec) : null;
    const planes = this.plane ? [this.plane] : [];
    for (const m of [...this.clipped, BACK, FRONT]) {
      m.clippingPlanes = planes;
      m.needsUpdate = true;
    }
    if (!this.plane || !body) return;
    // Stencil passes on the body's geometry (whole mesh, all faces).
    const back = new THREE.Mesh(body.geometry, BACK);
    const front = new THREE.Mesh(body.geometry, FRONT);
    back.renderOrder = front.renderOrder = 1;
    // The cap: a square on the plane, larger than the model.
    const size = box && !box.isEmpty() ? box.getSize(new THREE.Vector3()).length() * 2 + 10 : 400;
    const cap = new THREE.Mesh(new THREE.PlaneGeometry(size, size), CAP);
    const centre = box && !box.isEmpty() ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3();
    cap.position.copy(this.plane.projectPoint(centre, new THREE.Vector3()));
    cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.plane.normal.clone().negate());
    cap.renderOrder = 1.1;
    // Each frame starts from a clear stencil.
    cap.onAfterRender = (renderer) => renderer.clearStencil();
    this.group.add(back, front, cap);
  }

  /** Whether a world point is on the kept side (picking ignores the removed half). */
  keeps(p: THREE.Vector3): boolean {
    return !this.plane || this.plane.distanceToPoint(p) >= -1e-6;
  }
}
