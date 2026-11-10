// Mesh exporters for 3D printing and open interchange formats.
// Input is the kernel's triangulation; vertices are welded first so the
// exported shells are watertight (shared vertices across face boundaries).

import { strToU8, zipSync } from "fflate";

export interface RawMesh {
  vertices: Float32Array; // xyz
  triangles: Uint32Array; // indices into vertices
}

export interface IndexedMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export type MeshFormat = "stl" | "3mf" | "obj" | "ply" | "glb";
export type ExportFormat = MeshFormat | "step";

export const EXPORT_FORMATS: { id: ExportFormat; label: string; ext: string; hint: string }[] = [
  { id: "stl", label: "STL", ext: "stl", hint: "3D printing (binary)" },
  { id: "3mf", label: "3MF", ext: "3mf", hint: "3D printing, keeps units" },
  { id: "step", label: "STEP", ext: "step", hint: "Exact CAD geometry" },
  { id: "obj", label: "OBJ", ext: "obj", hint: "Mesh interchange" },
  { id: "ply", label: "PLY", ext: "ply", hint: "Mesh (binary)" },
  { id: "glb", label: "glTF (GLB)", ext: "glb", hint: "Web / AR viewers" },
];

/** Merges vertices closer than `eps` (mm) and drops degenerate triangles. */
export function weld(mesh: RawMesh, eps = 1e-5): IndexedMesh {
  const inv = 1 / eps;
  const map = new Map<string, number>();
  const pos: number[] = [];
  const remap = new Uint32Array(mesh.vertices.length / 3);
  for (let i = 0; i < remap.length; i++) {
    const x = mesh.vertices[i * 3], y = mesh.vertices[i * 3 + 1], z = mesh.vertices[i * 3 + 2];
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = pos.length / 3;
      map.set(key, idx);
      pos.push(x, y, z);
    }
    remap[i] = idx;
  }
  const idx: number[] = [];
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const a = remap[mesh.triangles[t]], b = remap[mesh.triangles[t + 1]], c = remap[mesh.triangles[t + 2]];
    if (a !== b && b !== c && a !== c) idx.push(a, b, c);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

function triNormal(p: Float32Array, a: number, b: number, c: number): [number, number, number] {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/** Binary STL (little endian), millimetres. */
export function toSTL(m: IndexedMesh, name = "OpenShape"): Blob {
  const n = m.indices.length / 3;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const header = strToU8(`${name} - exported by OpenShape`.slice(0, 80));
  new Uint8Array(buf, 0, 80).set(header);
  dv.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < n; t++) {
    const a = m.indices[t * 3], b = m.indices[t * 3 + 1], c = m.indices[t * 3 + 2];
    for (const v of triNormal(m.positions, a, b, c)) (dv.setFloat32(o, v, true), (o += 4));
    for (const i of [a, b, c]) for (let k = 0; k < 3; k++) (dv.setFloat32(o, m.positions[i * 3 + k], true), (o += 4));
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return new Blob([buf], { type: "model/stl" });
}

/** 3MF core spec: a zip with the content-types, relationships and model XML. */
export function to3MF(m: IndexedMesh, name = "OpenShape"): Blob {
  const f = (v: number) => (Math.round(v * 1e6) / 1e6).toString();
  const verts: string[] = [];
  for (let i = 0; i < m.positions.length; i += 3) verts.push(`<vertex x="${f(m.positions[i])}" y="${f(m.positions[i + 1])}" z="${f(m.positions[i + 2])}"/>`);
  const tris: string[] = [];
  for (let i = 0; i < m.indices.length; i += 3) tris.push(`<triangle v1="${m.indices[i]}" v2="${m.indices[i + 1]}" v3="${m.indices[i + 2]}"/>`);
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Application">OpenShape</metadata>
<metadata name="Title">${esc(name)}</metadata>
<resources>
<object id="1" type="model" name="${esc(name)}">
<mesh>
<vertices>${verts.join("")}</vertices>
<triangles>${tris.join("")}</triangles>
</mesh>
</object>
</resources>
<build><item objectid="1"/></build>
</model>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
  const zip = zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rels),
    "3D/3dmodel.model": strToU8(model),
  });
  return new Blob([zip], { type: "model/3mf" });
}

/** Wavefront OBJ with per-face normals; units are millimetres (OBJ itself has none). */
export function toOBJ(m: IndexedMesh, name = "OpenShape"): Blob {
  const lines = [`# Exported by OpenShape (units: mm)`, `o ${name.replace(/\s+/g, "_")}`];
  for (let i = 0; i < m.positions.length; i += 3) lines.push(`v ${m.positions[i]} ${m.positions[i + 1]} ${m.positions[i + 2]}`);
  for (let i = 0; i < m.indices.length; i += 3) lines.push(`f ${m.indices[i] + 1} ${m.indices[i + 1] + 1} ${m.indices[i + 2] + 1}`);
  return new Blob([lines.join("\n") + "\n"], { type: "model/obj" });
}

/** Binary little-endian PLY. */
export function toPLY(m: IndexedMesh): Blob {
  const nv = m.positions.length / 3, nf = m.indices.length / 3;
  const header = strToU8(
    `ply\nformat binary_little_endian 1.0\ncomment Exported by OpenShape (units: mm)\nelement vertex ${nv}\nproperty float x\nproperty float y\nproperty float z\nelement face ${nf}\nproperty list uchar int vertex_indices\nend_header\n`,
  );
  const body = new ArrayBuffer(nv * 12 + nf * 13);
  const dv = new DataView(body);
  let o = 0;
  for (let i = 0; i < m.positions.length; i++) (dv.setFloat32(o, m.positions[i], true), (o += 4));
  for (let i = 0; i < m.indices.length; i += 3) {
    dv.setUint8(o, 3);
    o += 1;
    for (let k = 0; k < 3; k++) (dv.setInt32(o, m.indices[i + k], true), (o += 4));
  }
  return new Blob([header, body], { type: "application/octet-stream" });
}

/** Binary glTF via three.js; glTF is metre-based and Y-up, so the mesh is converted. */
export async function toGLB(m: IndexedMesh, name = "OpenShape"): Promise<Blob> {
  const THREE = await import("three");
  const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.positions.slice(), 3));
  g.setIndex(new THREE.BufferAttribute(m.indices.slice(), 1));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xb8c4d6, metalness: 0.1, roughness: 0.55 }));
  mesh.name = name;
  // Z-up millimetres -> Y-up metres.
  mesh.rotation.x = -Math.PI / 2;
  mesh.scale.setScalar(0.001);
  const scene = new THREE.Scene();
  scene.add(mesh);
  const result = await new GLTFExporter().parseAsync(scene, { binary: true });
  return new Blob([result as ArrayBuffer], { type: "model/gltf-binary" });
}

export async function exportMesh(raw: RawMesh, format: MeshFormat, name: string): Promise<Blob> {
  const m = weld(raw);
  switch (format) {
    case "stl":
      return toSTL(m, name);
    case "3mf":
      return to3MF(m, name);
    case "obj":
      return toOBJ(m, name);
    case "ply":
      return toPLY(m);
    case "glb":
      return toGLB(m, name);
  }
}

/** Euler characteristic check used by tests: a closed genus-0 shell has V - E + F = 2. */
export function eulerCharacteristic(m: IndexedMesh): number {
  const edges = new Set<string>();
  for (let i = 0; i < m.indices.length; i += 3) {
    const t = [m.indices[i], m.indices[i + 1], m.indices[i + 2]];
    for (let k = 0; k < 3; k++) {
      const a = t[k], b = t[(k + 1) % 3];
      edges.add(a < b ? `${a},${b}` : `${b},${a}`);
    }
  }
  return m.positions.length / 3 - edges.size + m.indices.length / 3;
}
