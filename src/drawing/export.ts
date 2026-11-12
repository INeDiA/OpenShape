// Sheet exports from the same primitives the screen draws: SVG, PDF (vector,
// written directly: lines, filled arrowheads and Helvetica text) and DXF (R12,
// one layer per kind of line, in paper millimetres).

import type { DrawingSheet } from "../model/types";
import { paperSize, type Prim } from "./sheet";

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n = (v: number) => String(Math.round(v * 1000) / 1000);

/** The sheet as an SVG document (mm units). */
export function sheetSVG(s: DrawingSheet, prims: Prim[]): string {
  const [w, h] = paperSize(s);
  const Y = (y: number) => h - y;
  const body = prims
    .map((p) => {
      if (p.kind === "line") {
        return `<line x1="${n(p.a[0])}" y1="${n(Y(p.a[1]))}" x2="${n(p.b[0])}" y2="${n(Y(p.b[1]))}" stroke-width="${p.width}"${p.dash ? ' stroke-dasharray="3 1.5"' : ""}/>`;
      }
      if (p.kind === "tri") return `<polygon points="${p.pts.map((q) => `${n(q[0])},${n(Y(q[1]))}`).join(" ")}" fill="#000" stroke="none"/>`;
      const anchor = p.anchor;
      return `<text transform="translate(${n(p.at[0])} ${n(Y(p.at[1]))}) rotate(${n(-(p.angle ?? 0))})" font-size="${p.size}" text-anchor="${anchor}">${esc(p.text)}</text>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="#fff"/>
<g stroke="#000" stroke-linecap="round" fill="none" font-family="Helvetica, Arial, sans-serif">
${body.replace(/<text /g, '<text fill="#000" stroke="none" ')}
</g>
</svg>
`;
}

// ---- PDF ----------------------------------------------------------------------

/** Helvetica advance widths (per 1000 em) for the characters drawings use; others ~ average. */
function helveticaWidth(ch: string): number {
  if (/[0-9]/.test(ch)) return 556;
  if (ch === " " || ch === "." || ch === "," || ch === ":" || ch === "·") return 278;
  if (ch === "-") return 333;
  if (ch === "Ø") return 778;
  if (/[A-Z]/.test(ch)) return ch === "I" ? 278 : ch === "M" ? 833 : ch === "W" ? 944 : 667;
  if (/[a-z]/.test(ch)) return ch === "i" || ch === "l" || ch === "j" ? 222 : ch === "m" ? 833 : ch === "w" ? 722 : 500;
  return 556;
}
const textWidth = (t: string, size: number) => ([...t].reduce((s, c) => s + helveticaWidth(c), 0) / 1000) * size;

/** A PDF string literal in WinAnsi encoding. */
function pdfString(t: string): string {
  let out = "(";
  for (const ch of t) {
    const c = ch.codePointAt(0)!;
    if (ch === "(" || ch === ")" || ch === "\\") out += "\\" + ch;
    else if (c >= 32 && c < 127) out += ch;
    else if (ch === "Ø") out += "\\330";
    else if (ch === "·") out += "\\267";
    else if (ch === "°") out += "\\260";
    else out += "?";
  }
  return out + ")";
}

export function sheetPDF(s: DrawingSheet, prims: Prim[]): Uint8Array {
  const [w, h] = paperSize(s);
  const pt = 72 / 25.4;
  const ops: string[] = [`${n(pt)} 0 0 ${n(pt)} 0 0 cm`, "1 J 1 j 0 0 0 RG 0 0 0 rg"];
  let width = -1, dashed = false;
  for (const p of prims) {
    if (p.kind === "line") {
      if (p.width !== width) ops.push(`${p.width} w`), (width = p.width);
      if (!!p.dash !== dashed) ops.push(p.dash ? "[3 1.5] 0 d" : "[] 0 d"), (dashed = !!p.dash);
      ops.push(`${n(p.a[0])} ${n(p.a[1])} m ${n(p.b[0])} ${n(p.b[1])} l S`);
    } else if (p.kind === "tri") {
      const [a, b, c] = p.pts;
      ops.push(`${n(a[0])} ${n(a[1])} m ${n(b[0])} ${n(b[1])} l ${n(c[0])} ${n(c[1])} l f`);
    } else {
      const ang = ((p.angle ?? 0) * Math.PI) / 180, cos = Math.cos(ang), sin = Math.sin(ang);
      const shift = p.anchor === "middle" ? textWidth(p.text, p.size) / 2 : p.anchor === "end" ? textWidth(p.text, p.size) : 0;
      const x = p.at[0] - cos * shift, y = p.at[1] - sin * shift;
      ops.push(`BT /F1 ${n(p.size)} Tf ${n(cos)} ${n(sin)} ${n(-sin)} ${n(cos)} ${n(x)} ${n(y)} Tm ${pdfString(p.text)} Tj ET`);
    }
  }
  const content = ops.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(w * pt)} ${n(h * pt)}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Everything above is ASCII, so string length = byte length.
  return new TextEncoder().encode(out);
}

// ---- DXF ----------------------------------------------------------------------

const LAYERS: Record<Prim["layer"], { name: string; color: number; ltype: string }> = {
  visible: { name: "VISIBLE", color: 7, ltype: "CONTINUOUS" },
  hidden: { name: "HIDDEN", color: 8, ltype: "DASHED" },
  dims: { name: "DIMENSIONS", color: 3, ltype: "CONTINUOUS" },
  frame: { name: "FRAME", color: 7, ltype: "CONTINUOUS" },
};

const dxfText = (t: string) => t.replace(/Ø/g, "%%c").replace(/°/g, "%%d").replace(/·/g, "-");

export function sheetDXF(prims: Prim[]): string {
  const g: (string | number)[] = [];
  const add = (...pairs: (string | number)[]) => g.push(...pairs);
  add(0, "SECTION", 2, "HEADER", 9, "$ACADVER", 1, "AC1009", 0, "ENDSEC");
  add(0, "SECTION", 2, "TABLES");
  add(0, "TABLE", 2, "LTYPE", 70, 2);
  add(0, "LTYPE", 2, "CONTINUOUS", 70, 0, 3, "Solid line", 72, 65, 73, 0, 40, 0);
  add(0, "LTYPE", 2, "DASHED", 70, 0, 3, "Dashed __ __ __", 72, 65, 73, 2, 40, 4.5, 49, 3, 49, -1.5);
  add(0, "ENDTAB");
  add(0, "TABLE", 2, "LAYER", 70, Object.keys(LAYERS).length);
  for (const l of Object.values(LAYERS)) add(0, "LAYER", 2, l.name, 70, 0, 62, l.color, 6, l.ltype);
  add(0, "ENDTAB", 0, "ENDSEC");
  add(0, "SECTION", 2, "ENTITIES");
  for (const p of prims) {
    const layer = LAYERS[p.layer].name;
    if (p.kind === "line") add(0, "LINE", 8, layer, 10, n(p.a[0]), 20, n(p.a[1]), 30, 0, 11, n(p.b[0]), 21, n(p.b[1]), 31, 0);
    else if (p.kind === "tri") {
      const [a, b, c] = p.pts;
      add(0, "SOLID", 8, layer, 10, n(a[0]), 20, n(a[1]), 30, 0, 11, n(b[0]), 21, n(b[1]), 31, 0, 12, n(c[0]), 22, n(c[1]), 32, 0, 13, n(c[0]), 23, n(c[1]), 33, 0);
    } else {
      const h = p.anchor === "middle" ? 1 : p.anchor === "end" ? 2 : 0;
      add(0, "TEXT", 8, layer, 10, n(p.at[0]), 20, n(p.at[1]), 30, 0, 40, n(p.size), 1, dxfText(p.text), 50, n(p.angle ?? 0));
      if (h) add(72, h, 11, n(p.at[0]), 21, n(p.at[1]), 31, 0);
    }
  }
  add(0, "ENDSEC", 0, "EOF");
  const lines: string[] = [];
  for (let i = 0; i < g.length; i += 2) lines.push(String(g[i]).padStart(3, " "), String(g[i + 1]));
  return lines.join("\r\n") + "\r\n";
}
