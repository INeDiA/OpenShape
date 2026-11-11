// History editing: dependencies between features, reordering and bulk removal.
//
// A feature depends on every earlier feature whose id it mentions: the sketch
// an extrude uses, the features named inside face/edge references
// ("<extrudeId>:end", "[<id>:side:…|…]"), a target or moved body. Ids are
// unique random strings, so finding them in a feature's JSON is reliable.

import type { Document, Feature } from "./types";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** feature id -> ids of the features it references. */
export function dependencies(doc: Document): Map<string, Set<string>> {
  const ids = doc.features.map((f) => f.id);
  // One regex for all ids; an id must not be followed by more id characters ("ex-1" vs "ex-10").
  const re = ids.length ? new RegExp(`(${ids.map(escape).join("|")})(?![A-Za-z0-9_-])`, "g") : null;
  const out = new Map<string, Set<string>>();
  for (const f of doc.features) {
    const deps = new Set<string>();
    if (re) {
      // Only the fields that reference other features (not e.g. imported file data).
      const { id: _id, name: _name, ...rest } = f as Feature & Record<string, unknown>;
      if (rest.type === "import") delete (rest as Record<string, unknown>).data;
      for (const m of JSON.stringify(rest).matchAll(re)) if (m[1] !== f.id) deps.add(m[1]);
    }
    out.set(f.id, deps);
  }
  return out;
}

/** Every feature that (directly or not) depends on `id`. */
export function dependentsOf(doc: Document, id: string): Set<string> {
  const deps = dependencies(doc);
  const result = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [f, d] of deps) {
      if (result.has(f) || f === id) continue;
      if (d.has(id) || [...d].some((x) => result.has(x))) {
        result.add(f);
        changed = true;
      }
    }
  }
  return result;
}

export type MoveResult = { ok: true; doc: Document } | { ok: false; reason: string };

/**
 * Moves feature `id` so it ends up at `toIndex` in the list (an index in the
 * list *before* the move, as a drop position between rows). Refused when it
 * would put a feature before something it uses.
 */
export function moveFeature(doc: Document, id: string, toIndex: number): MoveResult {
  const from = doc.features.findIndex((f) => f.id === id);
  if (from < 0) return { ok: false, reason: "Feature not found" };
  const list = [...doc.features];
  const [f] = list.splice(from, 1);
  const at = Math.max(0, Math.min(list.length, toIndex > from ? toIndex - 1 : toIndex));
  list.splice(at, 0, f);
  if (at === from) return { ok: true, doc };

  const next = { ...doc, features: list };
  const deps = dependencies(next);
  const pos = new Map(list.map((x, i) => [x.id, i]));
  const byId = new Map(list.map((x) => [x.id, x]));
  for (const x of list) {
    for (const d of deps.get(x.id) ?? []) {
      if ((pos.get(d) ?? -1) > pos.get(x.id)!) {
        const user = byId.get(x.id)!, used = byId.get(d)!;
        return { ok: false, reason: `"${user.name}" uses "${used.name}", which would come after it` };
      }
    }
  }
  return { ok: true, doc: next };
}

/** Removes the given features (nothing else: dependents report their own errors). */
export function removeFeatures(doc: Document, ids: Iterable<string>): Document {
  const gone = new Set(ids);
  return { ...doc, features: doc.features.filter((f) => !gone.has(f.id)) };
}
