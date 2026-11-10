# OpenShape file format (`.openshape`), version 1

An OpenShape document is a single **UTF-8 JSON** file. It stores the *recipe*
(variables, sketches and features), not the resulting geometry: opening a file
replays the history to rebuild the model. Exported meshes (STL, 3MF, …) are the
way to share geometry with other tools.

- Extension: `.openshape`
- MIME type: `application/vnd.openshape+json`
- Units: millimetres for lengths, degrees for angles
- License: this specification is MIT, like the rest of the project

## Top level

```json
{
  "format": "openshape",
  "version": 1,
  "units": "mm",
  "meta": {
    "created": "2026-11-10T10:00:00.000Z",
    "modified": "2026-11-10T11:30:00.000Z",
    "generator": "OpenShape 0.1.0"
  },
  "document": { "variables": [], "features": [] }
}
```

| Field | Type | Notes |
|---|---|---|
| `format` | `"openshape"` | Required; readers reject anything else. |
| `version` | integer | Format version. Readers must refuse files newer than they support. |
| `units` | `"mm"` | Only millimetres in v1. |
| `meta` | object | Informational; never affects geometry. |
| `document` | object | See below. |

## Document

```ts
interface Document {
  variables: Variable[];
  features: Feature[];   // ordered history, replayed top to bottom
}

interface Variable {
  id: string;
  name: string;          // identifier: letters, digits, _; not a function/unit name
  expr: string;          // expression source, see "Expressions"
  value: number;         // cached result, so files are usable without evaluation
}
```

### Features

Every feature has:

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique within the document. Referenced by other features. |
| `type` | string | `sketch`, `extrude`, `revolve`, `fillet`, `chamfer`, `pushpull`, `shell`, `mirror`, `pattern`, `transform`, `import` |
| `name` | string | Display name. |
| `suppressed` | boolean | Skipped during replay when true. |
| `exprs` | object, optional | Maps a numeric field name to an expression, e.g. `{ "distance": "height / 2" }`. The field still holds the last computed number. |

Type-specific fields:

- **sketch**: `plane` (`"XY"`, `"XZ"`, `"YZ"`), optional `face` (persistent name of a planar face; when set, `plane` is ignored), `offset` (number, along the plane normal), `sketch` (see below).
- **extrude**: `sketchId` (an earlier sketch), `distance` (may be negative), `op`.
- **revolve**: `sketchId`, `axis` (`"X"`, `"Y"`, `"Z"`), `angle` (degrees), `op`.
- **fillet / chamfer**: `size` (radius or distance), `edges` (list of persistent edge names; empty means every edge), optional `overrides` (edge name → size for edges that differ from `size`).
- **pushpull**: `face` (persistent name of a planar face), `distance` (positive adds material, negative removes it). The face is moved: walls stretch and fillets or holes on it travel along; when the shape around the face doesn't allow that, the face is extruded instead.
- **shell**: `faces` (persistent names of faces to open), `thickness` (inward).
- **mirror**: `plane` (`"XY"`, `"XZ"`, `"YZ"`), `offset`. The mirrored copy is joined to the body.
- **pattern**: `mode` (`"linear"` or `"circular"`), `axis` (`"X"`, `"Y"`, `"Z"`), `count` (instances including the original), `spacing` (linear, mm), `angle` (circular, degrees; 360 spreads evenly). Copies are joined.
- **transform**: `body` (body id), `dx`, `dy`, `dz` (translation, mm), `axis` and `angle` (rotation in degrees about an axis through `pivotX/Y/Z`, applied before the translation).
- **import**: `fileName`, `format` (`"step"` or `"stl"`), `data` (base64 file content), `op`.

### Bodies

A document can hold several separate solids. A body is identified by the id of
the feature that created it: an `extrude`, `revolve` or `import` with `op: "new"`.
`join`, `cut` and `intersect` combine with the body named by the optional
`target` field, or with the most recently modified body when `target` is absent.
`mirror` and `pattern` also accept `target`. Features that reference topology
(`pushpull`, `shell`, `fillet`, `chamfer`, a sketch on a face) act on the body
that owns the referenced face or edge.

`op` is one of `new`, `join`, `cut`, `intersect` and says how the new solid combines with the current body.

### Sketch

Coordinates are in the sketch plane's local frame. For the `XZ` plane, local x is
global X and local y is global Z; for `YZ`, local x is global Y and local y is global Z.
On a face, the origin is the point of the face's plane closest to the world origin,
local x is world X projected onto the plane (world Y when X is nearly normal to it),
and the normal points out of the solid.

```ts
interface Sketch {
  entities: (Point | Line | Circle)[];  // points before the curves that use them
  constraints: Constraint[];
}
interface Point  { id: string; kind: "point";  x: number; y: number }
interface Line   { id: string; kind: "line";   p1: string; p2: string; construction?: boolean }
interface Circle { id: string; kind: "circle"; center: string; radius: number; construction?: boolean }
interface Arc    { id: string; kind: "arc";    center: string; start: string; end: string; radius: number; construction?: boolean }
```

Arcs run counter-clockwise from `start` to `end`. Lines and arcs that share a point id are connected. Construction geometry is ignored when
building solids. Closed loops of non-construction curves become faces; loops
nested inside others become holes.

Constraints (`kind` and fields):

| kind | fields |
|---|---|
| `coincident` | `a`, `b` (points) |
| `fixed` | `point` |
| `horizontal`, `vertical` | `line` |
| `parallel`, `perpendicular` | `a`, `b` (lines) |
| `equal` | `a`, `b` (two lines or two circles) |
| `pointOnLine`, `midpoint` | `point`, `line` |
| `pointOnCircle` | `point`, `circle` (a circle or an arc) |
| `tangent` | `line`, `circle` (a circle or an arc) |
| `distance` | `a`, `b` (points), `value`, `expr?` |
| `length` | `line`, `value`, `expr?` |
| `radius` | `circle` (a circle or an arc), `value`, `expr?` |
| `angle` | `a`, `b` (lines), `value` (degrees), `expr?` |

Stored point coordinates are the last solved positions, so a reader can display a
sketch without running a constraint solver.

## Expressions

Arithmetic `+ - * / % ^`, parentheses, variables by name, constants `pi` and `e`,
and functions `sqrt abs sign floor ceil round sin cos tan asin acos atan atan2 pow hypot min max`.
Trigonometric functions use degrees. Numbers may carry a unit suffix:
`mm`, `cm`, `m`, `in` for lengths and `deg`, `rad` for angles (`2cm + 5mm` is `25`).
Variables may reference each other in any order; cycles are errors.

## Persistent names

Fillets and chamfers refer to edges by **persistent names** rather than kernel ids,
so references survive upstream edits. Names are derived from the features that
created the adjacent faces; see `src/kernel/naming.ts` for the scheme.

## Compatibility

- Readers must ignore unknown fields in `meta`.
- New optional fields may appear in minor revisions without a version bump.
- Breaking changes bump `version`; OpenShape migrates older files on open.
