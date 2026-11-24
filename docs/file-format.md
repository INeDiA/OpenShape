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
| `type` | string | `sketch`, `plane`, `extrude`, `revolve`, `sweep`, `loft`, `fillet`, `chamfer`, `cove`, `draft`, `pushpull`, `shell`, `mirror`, `pattern`, `transform`, `split`, `splitface`, `faceoffset`, `replaceface`, `align`, `symmetry`, `boolean`, `layflat`, `teardrop`, `holefit`, `insert`, `import` |
| `name` | string | Display name. |
| `suppressed` | boolean | Skipped during replay when true. |
| `exprs` | object, optional | Maps a numeric field name to an expression, e.g. `{ "distance": "height / 2" }`. The field still holds the last computed number. |

Type-specific fields:

- **sketch**: `plane` (`"XY"`, `"XZ"`, `"YZ"`), optional `face` (persistent name of a planar face; when set, `plane` is ignored), optional `planeId` (an earlier `plane` feature; takes precedence over both), `offset` (number, along the plane normal), `sketch` (see below). Optional `images`: reference pictures shown under the sketch while editing, never geometry; each is `{ id, src, x, y, width, height, opacity }` with `src` a PNG, JPEG or WebP data URL, `x`, `y` the centre in sketch coordinates, `width`, `height` in mm (axis-aligned) and `opacity` from 0 to 1.
- **plane**: a construction plane. `mode` is `offset` (parallel to `face`, or to the standard plane `base` when there's no face, at `distance`), `angle` (through the straight edge `edge`, turned `angle` degrees from the planar `face`), `midplane` (halfway between the parallel planar faces `face` and `face2`) or `normal` (perpendicular to `edge` at `position`, 0 = start … 1 = end). `distance`, `angle`, `position` are always present. Removing a plane removes the sketches on it.
- **extrude**: `sketchId` (an earlier sketch), `distance` (may be negative), `op`, `regions?`, `throughAll?` (with `op` `cut` or `intersect`: go through the whole target body; `distance` then only gives the direction by its sign).
- **revolve**: `sketchId`, `axis` (`"X"`, `"Y"`, `"Z"`: a world axis through the origin), `axisLine?` (id of a line of the sketch to turn around instead; it takes precedence over `axis`), `angle` (degrees), `op`, `regions?`.

  `regions` (optional) lists the sketch regions to use; without it every closed
  region is used (nested loops become holes). A region is a closed loop minus the
  loops directly inside it, and its id is the ids of the curves bounding the loop,
  sorted and joined by `+` (with `#k` when several loops share the same curves),
  so it survives geometry changes that keep the boundary. A listed region that no
  longer exists makes the feature fail rather than use a different one.
- **sweep**: `sketchId` (the profile sketch), `regions?`, `pathId` (another earlier sketch holding the path: its non-construction curves joined end to end into one chain of lines, arcs and open splines, or a single circle, ellipse or closed spline), `op`. Faces are named `<sweepId>:start`, `<sweepId>:end` and `<sweepId>:sweep:<k>` (kernel order).
- **loft**: `sections` (two or more earlier sketch ids, in order; each contributes its largest closed profile, without holes), `ruled` (true: straight between profiles), `op`. Faces are named `<loftId>:start`, `<loftId>:end` and `<loftId>:loft:<k>`.
- **fillet / chamfer**: `size` (radius or distance), `edges` (list of persistent edge names; empty means every edge), optional `overrides` (edge name → size for edges that differ from `size`).
- **cove**: `size` (radius), `edges` (at least one persistent edge name). Removes a cylinder of that radius centred on each edge (a torus segment for circular edges), leaving a concave quarter-round groove; straight and circular edges only. New faces are named `<coveId>:cove:<edge>`.
- **draft**: `faces` (persistent names of the faces to tilt), `neutral` (persistent name of a planar face; its plane stays fixed and the pull direction points away from it, into the body), `angle` (degrees; positive narrows the part away from the neutral plane). Faces keep their names.
- **pushpull**: `face` (persistent name of a planar face), `distance` (positive adds material, negative removes it). The face is moved: walls stretch and fillets or holes on it travel along; when the shape around the face doesn't allow that, the face is extruded instead.
- **shell**: `faces` (persistent names of faces to open), `thickness` (inward).
- **mirror**: `plane` (`"XY"`, `"XZ"`, `"YZ"`), `offset`. The mirrored copy is joined to the body.
- **pattern**: `mode` (`"linear"` or `"circular"`), `axis` (`"X"`, `"Y"`, `"Z"`), `count` (instances including the original), `spacing` (linear, mm), `angle` (circular, degrees; 360 spreads evenly). Copies are joined.
- **transform**: `body` (body id), `dx`, `dy`, `dz` (translation, mm), `axis` and `angle` (rotation in degrees about an axis through `pivotX/Y/Z`), `scale?` (uniform factor about the pivot, default 1). Order: scale, rotate, translate.
- **Plane references** (`split`, `symmetry`, `replaceface`): `plane` (`"XY"`, `"XZ"`, `"YZ"`), `offset` (mm along the plane's normal), `planeId?` (a construction plane, takes precedence), `face?` (a planar face whose plane is used, after `planeId`).
- **split**: a plane reference, `body?` (body id; the latest body when absent), `toolBody?` (split with another body instead of the plane). The piece on the plane's normal side (or outside the tool body) keeps the body's id; the other becomes a new body with the split's id, its faces named `<splitId>:<original name>`. The cut faces are `<splitId>:cut` and `<splitId>:cut2`. A tool body is kept.
- **splitface**: `sketchId`. The sketch's curves (not construction geometry) divide the faces they lie on; the pieces of a face named `n` become `n#1`, `n#2`… ordered by position.
- **faceoffset**: `faces` (persistent names, any surface type, one body), `distance` (mm; positive adds material). Each moved face keeps its name; new side faces are `<id>:side`.
- **replaceface**: a plane reference (the target) and `faces` (persistent names, one body). The body is extended or trimmed along each face's normal until the face lies on the target plane; the new face keeps the replaced face's name. The target can't be perpendicular to a face.
- **align**: `bodies` (body ids to move), `reference` (body id, or `""` for the world origin), `x`, `y`, `z` (`"none"`, `"min"`, `"center"`, `"max"`): each body is translated so its bounding box matches the reference's on the chosen axes. Faces keep their names.
- **symmetry**: a plane reference, `body?`, `flip` (keep the half behind the plane instead of the one its normal points to). The kept half is mirrored onto the other side and joined; mirrored faces are named `<id>:copy1:<name>`, the faces on the plane `<id>:cut`.
- **teardrop**: `faces` (cylindrical hole faces), `flat` (cut the roof flat at the top of the hole). Adds a 45° roof over each horizontal hole (Z up) so it prints without supports; vertical holes are refused. New faces are named `<id>:roof:<hole face>`.
- **holefit**: `faces` (cylindrical hole faces), `amount` (mm added to each radius, along the whole hole). Pins are refused. New faces are named `<id>:hole:<hole face>`.
- **insert**: seats for heat-set threaded inserts. `faces` (cylindrical pilot-hole faces), `size` (`M2`, `M2.5`, `M3`, `M4`, `M5` or `custom`: the preset the numbers came from), `diameter` and `depth` (mm, the seat cut from the hole's opening), `flip` (through holes: seat at the lower opening instead of the upper). Blind holes use their open end. Pins, and holes already wider than the seat, are refused. New faces are named `<id>:seat:<hole face>`.
- **layflat**: `face` (persistent name of a planar face). Turns the body owning it so the face points straight down, then moves it so the body's lowest point is at z = 0 (the print bed). Faces keep their names.
- **boolean**: `op` (`"join"`, `"cut"`, `"intersect"`), `target` (body id that receives the result and keeps its id), `tools` (body ids combined with it), `keepTools` (false: the tool bodies are consumed), `clearance?` (cut only: the tools are grown by this gap in mm before subtracting, rounded at their convex edges, so the gap is the same all around). New faces are named `<booleanId>:new`.
- **import**: `fileName`, `format` (`"step"` or `"stl"`), `data` (base64 file content), `op`.

### Bodies

A document can hold several separate solids. A body is identified by the id of
the feature that created it: an `extrude`, `revolve`, `sweep`, `loft` or `import` with `op: "new"`.
`join`, `cut` and `intersect` combine with the body named by the optional
`target` field, or with the most recently modified body when `target` is absent.
`mirror` and `pattern` also accept `target`. `split` creates a second body (identified by the split's id). Features that reference topology
(`pushpull`, `shell`, `fillet`, `chamfer`, `cove`, `draft`, a sketch on a face) act on the body
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
  entities: (Point | Line | Circle | Arc | Ellipse | Spline)[];  // in any order
  constraints: Constraint[];
}
interface Point  { id: string; kind: "point";  x: number; y: number }
interface Line   { id: string; kind: "line";   p1: string; p2: string; construction?: boolean }
interface Circle { id: string; kind: "circle"; center: string; radius: number; construction?: boolean }
interface Arc    { id: string; kind: "arc";    center: string; start: string; end: string; radius: number; construction?: boolean }
interface Ellipse { id: string; kind: "ellipse"; center: string; major: string; minor: string; construction?: boolean }
interface Spline { id: string; kind: "spline"; points: string[]; closed?: boolean; construction?: boolean }
```

Arcs run counter-clockwise from `start` to `end`. An ellipse is given by its
center and one end of each axis (`major`, `minor`: point ids, perpendicular). A
spline is a uniform Catmull-Rom curve through its points (drawn as cubic Béziers
with control points offset by a sixth of the neighbours' chord); a closed spline
wraps around. Lines, arcs and open splines that share a point id are connected,
and a curve end lying on another line, arc or circle splits it there.
Construction geometry is ignored when building solids. The bounded regions of the
non-construction curves become faces: regions side by side are joined, regions
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
| `symmetric` | `a`, `b` (points mirrored across `line`) |
| `pointOnCircle` | `point`, `circle` (a circle or an arc) |
| `tangent` | `line` (a line or an arc), `circle` (a circle or an arc) |
| `tangentAt` | `a`, `b` (lines or arcs), `point` (where they meet), `reversed` (their directions are opposite: lines run `p1`→`p2`, arcs counter-clockwise) |
| `distance` | `a`, `b` (points), `value`, `expr?` |
| `length` | `line`, `value`, `expr?` |
| `pointLine` | `point`, `line` (distance to the infinite line; between parallel lines it uses a point of one), `value`, `expr?` |
| `radius` | `circle` (a circle or an arc), `value`, `expr?` |
| `angle` | `a`, `b` (lines), `value` (degrees), `expr?` |

Concentric curves are stored as a `coincident` between their centres, and an
ellipse's semi-axes as `distance` between its centre and an axis point. Sketch
patterns store their copies as ordinary curves.

Stored point coordinates are the last solved positions, so a reader can display a
sketch without running a constraint solver.

## Expressions

Arithmetic `+ - * / % ^`, parentheses, variables by name, constants `pi` and `e`,
and functions `sqrt abs sign floor ceil round sin cos tan asin acos atan atan2 pow hypot min max`.
Trigonometric functions use degrees. Numbers may carry a unit suffix:
`mm`, `cm`, `m`, `in` for lengths and `deg`, `rad` for angles (`2cm + 5mm` is `25`).
Variables may reference each other in any order; cycles are errors.

### Drawing

`drawing` (optional) is a 2D technical drawing of the model, one sheet:

| Field | Type | Meaning |
|---|---|---|
| `size` | string | `A4`, `A3`, `A2`, `A1` |
| `orientation` | string | `landscape` or `portrait` |
| `scale` | number | Paper mm per model mm (2 = 2:1, 0.5 = 1:2) |
| `projection` | string | `first` (ISO: top view below the front) or `third` (top view above) |
| `title`, `author` | string | Title block fields |
| `views` | array | `{ id, dir, x, y, hidden }`: `dir` is `front`, `back`, `top`, `bottom`, `left`, `right` or `iso`; `x`, `y` place the centre of the view on the sheet (paper mm from the bottom-left corner); `hidden` draws hidden edges dashed. |
| `dimensions` | array | `{ id, view, kind, a, b?, r?, offset }`: `kind` is `horizontal`, `vertical`, `aligned`, `diameter` or `radius`; `a` and `b` are points in the view's coordinates (model mm, x right, y up), re-snapped to the nearest vertex (or circle centre) when the model changes; `r` is the radius of the circle a diameter or radius was put on; `offset` is the distance of the dimension line from the points (paper mm) or, for circles, the angle of the leader (degrees). |

Views are hidden-line projections of the final model, recomputed on load.

## Persistent names

Fillets and chamfers refer to edges by **persistent names** rather than kernel ids,
so references survive upstream edits. Names are derived from the features that
created the adjacent faces; see `src/kernel/naming.ts` for the scheme.

## Compatibility

- Readers must ignore unknown fields in `meta`.
- New optional fields may appear in minor revisions without a version bump.
- Breaking changes bump `version`; OpenShape migrates older files on open.
