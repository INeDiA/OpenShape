import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { eulerCharacteristic, exportBodies, mergeMeshes, to3MF, toOBJ, toPLY, toSTL, weld, type RawMesh } from "./exporters";

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

describe("exporting several bodies", () => {
  const moved = (dx: number): RawMesh => {
    const c = cube();
    const v = new Float32Array(c.vertices);
    for (let i = 0; i < v.length; i += 3) v[i] += dx;
    return { vertices: v, triangles: c.triangles };
  };

  it("merges bodies into one mesh, shifting the indices", () => {
    const m = mergeMeshes([cube(), moved(20)]);
    expect(m.vertices.length).toBe(cube().vertices.length * 2);
    expect(Math.max(...m.triangles)).toBe(m.vertices.length / 3 - 1);
    const w = weld(m);
    // Two separate closed cubes: Euler characteristic 2 each.
    expect(eulerCharacteristic(w)).toBe(4);
  });

  it("writes one 3MF object per body", async () => {
    const { blob, fileName } = await exportBodies([{ name: "Base", mesh: cube() }, { name: "Lid", mesh: moved(20) }], "3mf", "Box", true);
    expect(fileName).toBe("Box.3mf");
    const model = strFromU8(unzipSync(new Uint8Array(await blob.arrayBuffer()))["3D/3dmodel.model"]);
    expect(model.match(/<object /g)?.length).toBe(2);
    expect(model).toContain('name="Lid"');
    expect(model.match(/<item objectid=/g)?.length).toBe(2);
  });

  it("zips one file per body for other formats, or merges them when asked", async () => {
    const parts = [{ name: "Base", mesh: cube() }, { name: "Lid/top", mesh: moved(20) }, { name: "Base", mesh: moved(40) }];
    const { blob, fileName } = await exportBodies(parts, "stl", "Box", true);
    expect(fileName).toBe("Box (STL).zip");
    const files = Object.keys(unzipSync(new Uint8Array(await blob.arrayBuffer()))).sort();
    expect(files).toEqual(["Base 2.stl", "Base.stl", "Lid-top.stl"]);
    const one = await exportBodies(parts, "stl", "Box", false);
    expect(one.fileName).toBe("Box.stl");
    // 12 triangles per cube.
    expect(new DataView(await one.blob.arrayBuffer()).getUint32(80, true)).toBe(36);
  });
});
