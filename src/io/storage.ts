// Autosave in the browser and file open/save, using the File System Access API
// when available (Chromium) and plain download/upload otherwise.

import type { Document } from "../model/types";
import { FILE_EXTENSION, MIME_TYPE, parseFile, serialize, type FileMeta } from "./fileFormat";

const AUTOSAVE_KEY = "openshape.autosave.v1";
export const GENERATOR = "OpenShape 0.1.0";

export interface Autosave {
  doc: Document;
  meta: FileMeta;
  fileName: string;
}

const BROKEN_KEY = "openshape.autosave.unreadable";

/** Set when the last autosave could not be read; it was kept aside under BROKEN_KEY. */
export let autosaveProblem: string | null = null;

export function loadAutosave(): Autosave | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const { text, fileName } = JSON.parse(raw) as { text: string; fileName: string };
    const { doc, meta } = parseFile(text);
    return { doc, meta, fileName };
  } catch (e) {
    // Never let the next autosave overwrite work we failed to read: keep a copy aside.
    autosaveProblem = e instanceof Error ? e.message : String(e);
    try {
      if (raw) localStorage.setItem(BROKEN_KEY, raw);
    } catch {
      /* storage full or blocked */
    }
    return null;
  }
}

export function writeAutosave(doc: Document, meta: FileMeta, fileName: string): boolean {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ text: serialize(doc, meta), fileName }));
    return true;
  } catch {
    return false; // quota exceeded or storage blocked
  }
}

export function clearAutosave() {
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    /* ignore */
  }
}

// ---- undo history --------------------------------------------------------------

const HISTORY_KEY = "openshape.history.v1";
/** Upper bound for the stored undo history (localStorage holds ~5 MB per origin). */
const HISTORY_BUDGET = 2_500_000;

export interface StoredHistory {
  past: Document[];
  future: Document[];
}

/** JSON with sorted keys, so equal documents compare equal however they were built. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x,
  );
}

/**
 * Saves undo/redo stacks next to the current document. The oldest undo steps
 * (then the farthest redo steps) are dropped until the record fits the budget.
 */
export function writeHistory(current: Document, past: Document[], future: Document[]): boolean {
  try {
    const cur = canonical(current);
    const p = past.map((d) => JSON.stringify(d));
    const f = future.map((d) => JSON.stringify(d));
    let size = cur.length + p.reduce((s, x) => s + x.length, 0) + f.reduce((s, x) => s + x.length, 0);
    while (size > HISTORY_BUDGET && p.length) size -= p.shift()!.length;
    while (size > HISTORY_BUDGET && f.length) size -= f.pop()!.length;
    localStorage.setItem(HISTORY_KEY, `{"current":${cur},"past":[${p.join(",")}],"future":[${f.join(",")}]}`);
    return true;
  } catch {
    return false;
  }
}

/** The stored stacks, only if they were saved for `current` (otherwise they belong to another state). */
export function loadHistory(current: Document): StoredHistory | null {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return null;
    const h = JSON.parse(raw) as StoredHistory & { current: Document };
    if (canonical(h.current) !== canonical(current) || !Array.isArray(h.past) || !Array.isArray(h.future)) return null;
    return { past: h.past, future: h.future };
  } catch {
    return null;
  }
}

// ---- files -------------------------------------------------------------------

interface FsHandle {
  name: string;
  createWritable(): Promise<{ write(data: Blob | string): Promise<void>; close(): Promise<void> }>;
  getFile(): Promise<File>;
}
type PickerWindow = Window & {
  showSaveFilePicker?: (o: unknown) => Promise<FsHandle>;
  showOpenFilePicker?: (o: unknown) => Promise<FsHandle[]>;
};

const pickerTypes = [{ description: "OpenShape document", accept: { [MIME_TYPE]: [FILE_EXTENSION] } }];
let currentHandle: FsHandle | null = null;

export const resetFileHandle = () => (currentHandle = null);

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** Saves the document. Returns the file name used, or null if the user cancelled. */
export async function saveDocument(doc: Document, meta: FileMeta, fileName: string, saveAs = false): Promise<string | null> {
  const text = serialize(doc, meta);
  const w = window as PickerWindow;
  if (w.showSaveFilePicker) {
    try {
      if (!currentHandle || saveAs) currentHandle = await w.showSaveFilePicker({ suggestedName: fileName, types: pickerTypes });
      const out = await currentHandle.createWritable();
      await out.write(new Blob([text], { type: MIME_TYPE }));
      await out.close();
      return currentHandle.name;
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
  }
  downloadBlob(new Blob([text], { type: MIME_TYPE }), fileName);
  return fileName;
}

/** Lets the user pick a file and parses it. Returns null if cancelled. */
export async function openDocument(): Promise<(Autosave & { fileName: string }) | null> {
  const w = window as PickerWindow;
  let file: File | null = null;
  if (w.showOpenFilePicker) {
    try {
      const [h] = await w.showOpenFilePicker({ types: pickerTypes, multiple: false });
      currentHandle = h;
      file = await h.getFile();
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
  } else {
    file = await new Promise<File | null>((resolve) => {
      const input = Object.assign(document.createElement("input"), { type: "file", accept: `${FILE_EXTENSION},application/json` });
      input.onchange = () => resolve(input.files?.[0] ?? null);
      input.oncancel = () => resolve(null);
      input.click();
    });
    currentHandle = null;
  }
  if (!file) return null;
  const { doc, meta } = parseFile(await file.text());
  return { doc, meta, fileName: file.name };
}
