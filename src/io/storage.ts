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

export function loadAutosave(): Autosave | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const { text, fileName } = JSON.parse(raw) as { text: string; fileName: string };
    const { doc, meta } = parseFile(text);
    return { doc, meta, fileName };
  } catch {
    return null; // corrupt or unavailable storage: start fresh
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
