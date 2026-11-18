// The .openshape file format: UTF-8 JSON, documented in docs/file-format.md.
// Bump FORMAT_VERSION on breaking changes and add a step to `migrate`.

import type { Document, DrawingSheet, Feature, Variable } from "../model/types";
import type { SkConstraint, SkEntity } from "../sketch/model";

export const FORMAT_NAME = "openshape";
export const FORMAT_VERSION = 1;
export const FILE_EXTENSION = ".openshape";
export const MIME_TYPE = "application/vnd.openshape+json";

export interface FileMeta {
  /** ISO timestamps */
  created: string;
  modified: string;
  /** Application that last wrote the file, e.g. "OpenShape 0.1.0". */
  generator: string;
}

export interface OpenShapeFile {
  format: typeof FORMAT_NAME;
  version: number;
  units: "mm";
  meta: FileMeta;
  document: Document;
}

export class FileFormatError extends Error {}

export function serialize(doc: Document, meta: FileMeta): string {
  const file: OpenShapeFile = { format: FORMAT_NAME, version: FORMAT_VERSION, units: "mm", meta, document: doc };
  return JSON.stringify(file, null, 2);
}

export function parseFile(text: string): { doc: Document; meta: FileMeta } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FileFormatError("Not a valid OpenShape file (invalid JSON).");
  }
  if (!isObj(raw) || raw.format !== FORMAT_NAME) throw new FileFormatError("Not an OpenShape file.");
  if (typeof raw.version !== "number") throw new FileFormatError("Missing format version.");
  if (raw.version > FORMAT_VERSION) throw new FileFormatError(`File version ${raw.version} is newer than this app supports (${FORMAT_VERSION}). Update OpenShape.`);
  if (raw.units !== "mm") throw new FileFormatError(`Unsupported units "${String(raw.units)}".`);
  const migrated = migrate(raw);
  const doc = validateDocument(migrated.document);
  const m = isObj(migrated.meta) ? migrated.meta : {};
  const now = new Date().toISOString();
  return {
    doc,
    meta: {
      created: typeof m.created === "string" ? m.created : now,
      modified: typeof m.modified === "string" ? m.modified : now,
      generator: typeof m.generator === "string" ? m.generator : "unknown",
    },
  };
}

/** Upgrades older files step by step. Version 1 is the first public version. */
function migrate(file: Record<string, unknown>): Record<string, unknown> {
  return file;
}

// ---- validation --------------------------------------------------------------
// Structural checks with readable messages; not a full schema validator.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function need(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new FileFormatError(`Invalid document: ${msg}`);
}

const num = (v: unknown, at: string) => need(typeof v === "number" && Number.isFinite(v), `${at} must be a number`);
const str = (v: unknown, at: string) => need(typeof v === "string", `${at} must be a string`);

export function validateDocument(raw: unknown): Document {
  need(isObj(raw), "document is missing");
  const variables = raw.variables ?? [];
  need(Array.isArray(variables), "variables must be a list");
  need(Array.isArray(raw.features), "features must be a list");

  const varNames = new Set<string>();
  for (const [i, v] of (variables as unknown[]).entries()) {
    need(isObj(v), `variable ${i} is not an object`);
    str(v.id, `variables[${i}].id`);
    str(v.name, `variables[${i}].name`);
    str(v.expr, `variables[${i}].expr`);
    num(v.value, `variables[${i}].value`);
    need(!varNames.has(v.name as string), `duplicate variable "${String(v.name)}"`);
    varNames.add(v.name as string);
  }

  const ids = new Set<string>();
  const sketchIds = new Set<string>();
  const planeIds = new Set<string>();
  for (const [i, f] of (raw.features as unknown[]).entries()) {
    const at = `features[${i}]`;
    need(isObj(f), `${at} is not an object`);
    str(f.id, `${at}.id`);
    str(f.name, `${at}.name`);
    need(!ids.has(f.id as string), `duplicate feature id ${String(f.id)}`);
    ids.add(f.id as string);
    if (f.exprs !== undefined) need(isObj(f.exprs), `${at}.exprs must be an object`);
    switch (f.type) {
      case "sketch":
        need(["XY", "XZ", "YZ"].includes(f.plane as string), `${at}.plane is invalid`);
        num(f.offset, `${at}.offset`);
        if (f.face !== undefined) str(f.face, `${at}.face`);
        if (f.planeId !== undefined) need(planeIds.has(f.planeId as string), `${at} references a plane that doesn't precede it`);
        validateSketch(f.sketch, `${at}.sketch`);
        sketchIds.add(f.id as string);
        break;
      case "extrude":
      case "revolve":
        str(f.sketchId, `${at}.sketchId`);
        need(sketchIds.has(f.sketchId as string), `${at} references a sketch that doesn't precede it`);
        need(["new", "join", "cut", "intersect"].includes(f.op as string), `${at}.op is invalid`);
        if (f.type === "extrude") {
          num(f.distance, `${at}.distance`);
          if (f.throughAll !== undefined) need(typeof f.throughAll === "boolean", `${at}.throughAll must be true or false`);
        } else {
          need(["X", "Y", "Z"].includes(f.axis as string), `${at}.axis is invalid`);
          num(f.angle, `${at}.angle`);
        }
        break;
      case "sweep":
        str(f.sketchId, `${at}.sketchId`);
        str(f.pathId, `${at}.pathId`);
        need(sketchIds.has(f.sketchId as string) && sketchIds.has(f.pathId as string), `${at} references a sketch that doesn't precede it`);
        need(["new", "join", "cut", "intersect"].includes(f.op as string), `${at}.op is invalid`);
        break;
      case "loft":
        need(Array.isArray(f.sections) && f.sections.length >= 2 && f.sections.every((x) => typeof x === "string" && sketchIds.has(x)), `${at}.sections must list at least two earlier sketches`);
        need(typeof f.ruled === "boolean", `${at}.ruled must be true or false`);
        need(["new", "join", "cut", "intersect"].includes(f.op as string), `${at}.op is invalid`);
        break;
      case "plane":
        need(["offset", "angle", "midplane", "normal"].includes(f.mode as string), `${at}.mode is invalid`);
        if (f.base !== undefined) need(["XY", "XZ", "YZ"].includes(f.base as string), `${at}.base is invalid`);
        for (const k of ["face", "face2", "edge"] as const) if (f[k] !== undefined) str(f[k], `${at}.${k}`);
        for (const k of ["distance", "angle", "position"] as const) {
          if (f[k] === undefined) f[k] = k === "angle" ? 45 : 0;
          num(f[k], `${at}.${k}`);
        }
        planeIds.add(f.id as string);
        break;
      case "teardrop":
      case "holefit":
        need(Array.isArray(f.faces) && f.faces.every((x) => typeof x === "string"), `${at}.faces must be a list of names`);
        if (f.type === "teardrop") need(typeof f.flat === "boolean", `${at}.flat must be true or false`);
        else num(f.amount, `${at}.amount`);
        break;
      case "insert":
        need(Array.isArray(f.faces) && f.faces.every((x) => typeof x === "string"), `${at}.faces must be a list of names`);
        need(["M2", "M2.5", "M3", "M4", "M5", "custom"].includes(f.size as string), `${at}.size is invalid`);
        num(f.diameter, `${at}.diameter`);
        num(f.depth, `${at}.depth`);
        if (f.flip === undefined) f.flip = false;
        need(typeof f.flip === "boolean", `${at}.flip must be true or false`);
        break;
      case "layflat":
        str(f.face, `${at}.face`);
        break;
      case "boolean":
        need(["join", "cut", "intersect"].includes(f.op as string), `${at}.op is invalid`);
        str(f.target, `${at}.target`);
        need(Array.isArray(f.tools) && f.tools.every((x) => typeof x === "string"), `${at}.tools must be a list of body ids`);
        if (typeof f.keepTools !== "boolean") f.keepTools = false;
        if (f.clearance !== undefined) num(f.clearance, `${at}.clearance`);
        break;
      case "draft":
        need(Array.isArray(f.faces) && f.faces.every((x) => typeof x === "string"), `${at}.faces must be a list of names`);
        str(f.neutral, `${at}.neutral`);
        num(f.angle, `${at}.angle`);
        break;
      case "fillet":
      case "chamfer":
        num(f.size, `${at}.size`);
        if (f.edges === undefined) f.edges = [];
        need(Array.isArray(f.edges) && f.edges.every((e) => typeof e === "string"), `${at}.edges must be a list of names`);
        if (f.overrides !== undefined) need(isObj(f.overrides) && Object.values(f.overrides).every((x) => typeof x === "number"), `${at}.overrides must map edge names to numbers`);
        break;
      case "cove":
        num(f.size, `${at}.size`);
        need(Array.isArray(f.edges) && f.edges.length > 0 && f.edges.every((e) => typeof e === "string"), `${at}.edges must list at least one edge name`);
        break;
      case "pushpull":
        str(f.face, `${at}.face`);
        num(f.distance, `${at}.distance`);
        break;
      case "shell":
        num(f.thickness, `${at}.thickness`);
        need(Array.isArray(f.faces) && f.faces.every((x) => typeof x === "string"), `${at}.faces must be a list of names`);
        break;
      case "mirror":
        need(["XY", "XZ", "YZ"].includes(f.plane as string), `${at}.plane is invalid`);
        num(f.offset, `${at}.offset`);
        break;
      case "pattern":
        need(f.mode === "linear" || f.mode === "circular", `${at}.mode is invalid`);
        need(["X", "Y", "Z"].includes(f.axis as string), `${at}.axis is invalid`);
        num(f.count, `${at}.count`);
        num(f.spacing, `${at}.spacing`);
        num(f.angle, `${at}.angle`);
        break;
      case "transform":
        str(f.body, `${at}.body`);
        for (const k of ["dx", "dy", "dz", "angle", "pivotX", "pivotY", "pivotZ"]) num(f[k], `${at}.${k}`);
        need(["X", "Y", "Z"].includes(f.axis as string), `${at}.axis is invalid`);
        break;
      case "import":
        str(f.fileName, `${at}.fileName`);
        need(f.format === "step" || f.format === "stl", `${at}.format is invalid`);
        str(f.data, `${at}.data`);
        need(["new", "join", "cut", "intersect"].includes(f.op as string), `${at}.op is invalid`);
        break;
      default:
        throw new FileFormatError(`Invalid document: ${at} has unknown type "${String(f.type)}"`);
    }
    if (f.target !== undefined) str(f.target, `${at}.target`);
    if (typeof f.suppressed !== "boolean") f.suppressed = false;
  }

  const doc: Document = { variables: variables as Variable[], features: raw.features as Feature[] };
  if (raw.drawing !== undefined) doc.drawing = validateDrawing(raw.drawing);
  return doc;
}

const VIEW_DIRS = ["front", "back", "top", "bottom", "left", "right", "iso"];
const DIM_KINDS = ["horizontal", "vertical", "aligned", "diameter", "radius"];
const pt = (v: unknown, at: string) => need(Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && Number.isFinite(x)), `${at} must be [x, y]`);

function validateDrawing(raw: unknown): DrawingSheet {
  need(isObj(raw), "drawing is invalid");
  need(["A4", "A3", "A2", "A1"].includes(raw.size as string), "drawing.size is invalid");
  need(raw.orientation === "landscape" || raw.orientation === "portrait", "drawing.orientation is invalid");
  num(raw.scale, "drawing.scale");
  need((raw.scale as number) > 0, "drawing.scale must be > 0");
  need(raw.projection === "first" || raw.projection === "third", "drawing.projection is invalid");
  if (typeof raw.title !== "string") raw.title = "";
  if (typeof raw.author !== "string") raw.author = "";
  need(Array.isArray(raw.views) && Array.isArray(raw.dimensions), "drawing needs views and dimensions");
  const views = new Set<string>();
  for (const [i, v] of (raw.views as unknown[]).entries()) {
    const at = `drawing.views[${i}]`;
    need(isObj(v), `${at} is invalid`);
    str(v.id, `${at}.id`);
    need(VIEW_DIRS.includes(v.dir as string), `${at}.dir is invalid`);
    num(v.x, `${at}.x`);
    num(v.y, `${at}.y`);
    if (typeof v.hidden !== "boolean") v.hidden = true;
    views.add(v.id as string);
  }
  for (const [i, d] of (raw.dimensions as unknown[]).entries()) {
    const at = `drawing.dimensions[${i}]`;
    need(isObj(d), `${at} is invalid`);
    str(d.id, `${at}.id`);
    need(views.has(d.view as string), `${at} references a missing view`);
    need(DIM_KINDS.includes(d.kind as string), `${at}.kind is invalid`);
    pt(d.a, `${at}.a`);
    if (d.kind !== "diameter" && d.kind !== "radius") pt(d.b, `${at}.b`);
    num(d.offset, `${at}.offset`);
    if (d.r !== undefined) num(d.r, `${at}.r`);
  }
  return raw as unknown as DrawingSheet;
}

function validateSketch(raw: unknown, at: string) {
  need(isObj(raw), `${at} is missing`);
  need(Array.isArray(raw.entities) && Array.isArray(raw.constraints), `${at} needs entities and constraints`);
  // Entities may come in any order; references are checked against all ids.
  const ids = new Set<string>();
  for (const [i, e] of (raw.entities as SkEntity[]).entries()) {
    need(isObj(e) && typeof e.id === "string", `${at}.entities[${i}] is invalid`);
    ids.add(e.id);
  }
  for (const [i, e] of (raw.entities as SkEntity[]).entries()) {
    if (e.kind === "point") {
      num(e.x, `${at}.entities[${i}].x`);
      num(e.y, `${at}.entities[${i}].y`);
    } else if (e.kind === "line") {
      need(ids.has(e.p1) && ids.has(e.p2), `${at}.entities[${i}] references missing points`);
    } else if (e.kind === "circle") {
      need(ids.has(e.center), `${at}.entities[${i}] references a missing center`);
      num(e.radius, `${at}.entities[${i}].radius`);
    } else if (e.kind === "arc") {
      need(ids.has(e.center) && ids.has(e.start) && ids.has(e.end), `${at}.entities[${i}] references missing points`);
      num(e.radius, `${at}.entities[${i}].radius`);
    } else if (e.kind === "ellipse") {
      need(ids.has(e.center) && ids.has(e.major) && ids.has(e.minor), `${at}.entities[${i}] references missing points`);
    } else if (e.kind === "spline") {
      need(Array.isArray(e.points) && e.points.length >= 2 && e.points.every((p) => ids.has(p)), `${at}.entities[${i}] references missing points`);
    } else {
      throw new FileFormatError(`Invalid document: ${at}.entities[${i}] has unknown kind`);
    }
  }
  for (const [i, c] of (raw.constraints as SkConstraint[]).entries()) {
    need(isObj(c) && typeof c.id === "string" && typeof c.kind === "string", `${at}.constraints[${i}] is invalid`);
    if ("value" in c) num(c.value, `${at}.constraints[${i}].value`);
  }
}
