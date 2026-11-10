import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { eulerCharacteristic, to3MF, toOBJ, toPLY, toSTL, weld, type RawMesh } from "./exporters";

// Unit cube as 6 faces x 2 triangles with per-face (unshared) vertices, like a kernel mesh.
function cube(): RawMesh {
  const faces = [
    [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
    [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
    [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
    [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
    [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
  ];
  const v: number[] = [], t: number[] = [];
  for (const f of faces) {
    const base = v.length / 3;
    for (const p of f) v.push(...p);
    t.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { vertices: new Float32Array(v), triangles: new Uint32Array(t) };
}

describe("mesh export", () => {
  it("welds into a closed shell", () => {
    const m = weld(cube());
    expect(m.positions.length / 3).toBe(8);
    expect(m.indices.length / 3).toBe(12);
    expect(eulerCharacteristic(m)).toBe(2);
  });

  it("writes binary STL with the right size", async () => {
    const b = toSTL(weld(cube()));
    expect(b.size).toBe(84 + 12 * 50);
    const dv = new DataView(await b.arrayBuffer());
    expect(dv.getUint32(80, true)).toBe(12);
  });

  it("writes a valid 3MF package in millimetres", async () => {
    const files = unzipSync(new Uint8Array(await to3MF(weld(cube()), "Cube").arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(["3D/3dmodel.model", "[Content_Types].xml", "_rels/.rels"]);
    const model = strFromU8(files["3D/3dmodel.model"]);
    expect(model).toContain('unit="millimeter"');
    expect(model.match(/<vertex /g)).toHaveLength(8);
    expect(model.match(/<triangle /g)).toHaveLength(12);
  });

  it("writes OBJ and PLY", async () => {
    const obj = await toOBJ(weld(cube())).text();
    expect(obj.split("\n").filter((l) => l.startsWith("v ")).length).toBe(8);
    expect(obj.split("\n").filter((l) => l.startsWith("f ")).length).toBe(12);
    const ply = new Uint8Array(await toPLY(weld(cube())).arrayBuffer());
    const header = strFromU8(ply.slice(0, 200));
    expect(header).toContain("element vertex 8");
    expect(header).toContain("element face 12");
  });
});
