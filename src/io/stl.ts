// Minimal STL reader (binary and ASCII). Returns triangles as flat xyz triples.

export type Triangle = [number, number, number, number, number, number, number, number, number];

export function parseSTL(bytes: Uint8Array): Triangle[] {
  if (bytes.length >= 84) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint32(80, true);
    // Binary when the size matches exactly; ASCII files usually start with "solid".
    if (84 + n * 50 === bytes.length) {
      const out: Triangle[] = [];
      for (let i = 0; i < n; i++) {
        const o = 84 + i * 50 + 12; // skip the normal
        const t = Array.from({ length: 9 }, (_, k) => dv.getFloat32(o + k * 4, true)) as Triangle;
        out.push(t);
      }
      return out;
    }
  }
  const text = new TextDecoder().decode(bytes);
  if (!/^\s*solid/i.test(text)) throw new Error("Not a valid STL file");
  const nums = [...text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  if (nums.length % 3 !== 0 || nums.some((v) => v.some((x) => !Number.isFinite(x)))) throw new Error("Malformed ASCII STL");
  const out: Triangle[] = [];
  for (let i = 0; i < nums.length; i += 3) out.push([...nums[i], ...nums[i + 1], ...nums[i + 2]] as Triangle);
  return out;
}
