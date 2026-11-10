import { describe, expect, it } from "vitest";
import { demoDocument } from "../model/doc";
import { FileFormatError, parseFile, serialize } from "./fileFormat";

const meta = { created: "2026-11-10T10:00:00.000Z", modified: "2026-11-10T11:00:00.000Z", generator: "test" };

describe(".openshape files", () => {
  it("round-trips a document", () => {
    const doc = { ...demoDocument(), variables: [{ id: "v1", name: "w", expr: "40", value: 40 }] };
    const back = parseFile(serialize(doc, meta));
    expect(back.doc).toEqual(doc);
    expect(back.meta).toEqual(meta);
  });

  it("rejects foreign and future files with clear messages", () => {
    expect(() => parseFile("{nope")).toThrow(FileFormatError);
    expect(() => parseFile(JSON.stringify({ format: "other" }))).toThrow(/Not an OpenShape file/);
    expect(() => parseFile(JSON.stringify({ format: "openshape", version: 99, units: "mm", document: {} }))).toThrow(/newer/);
  });

  it("rejects broken references", () => {
    const doc = demoDocument();
    const text = serialize({ ...doc, features: doc.features.slice(1) }, meta); // extrude without its sketch
    expect(() => parseFile(text)).toThrow(/references a sketch/);
  });

  it("fills defaults for optional fields", () => {
    const doc = demoDocument();
    const raw = JSON.parse(serialize(doc, meta));
    delete raw.document.variables;
    const fillet = raw.document.features.find((f: { type: string }) => f.type === "fillet");
    delete fillet.edges;
    const back = parseFile(JSON.stringify(raw));
    expect(back.doc.variables).toEqual([]);
    expect(back.doc.features.find((f) => f.type === "fillet")).toMatchObject({ edges: [] });
  });
});
