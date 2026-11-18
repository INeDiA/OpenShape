import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KernelClient } from "./kernel/client";
import {
  demoDocument,
  hasBody,
  lastSketch,
  makeBoolean,
  makeCove,
  makeDraft,
  makeEdgeTreatment,
  makeExtrude,
  makeLayFlat,
  makeTeardrop,
  makeHoleFit,
  makeInsert,
  makePlane,
  makeLoft,
  makeSweep,
  makeImport,
  makeMirror,
  makePattern,
  makePushPull,
  makeShell,
  makeSketch,
  makeSketchOnFace,
  makeSketchOnPlane,
  removeFeature,
  sketchUses,
  updateFeature,
} from "./model/doc";
import { findLoops } from "./sketch/profiles";
import { sketchPath } from "./sketch/path";
import type { Document, Feature, FeatureStatus, Measurement, MeshData, PlaneName, PlanePreview, SketchFeature, SketchPreview } from "./model/types";
import { SketchEditor } from "./sketch/SketchEditor";
import { loadSolver, solve, solverReady } from "./sketch/solver";
import { resolveDocument, type SketchSolver } from "./model/resolve";
import { VariablesPanel } from "./ui/VariablesPanel";
import { DrawingWorkspace } from "./drawing/DrawingWorkspace";
import { useManipulation, type ContextActions } from "./ui/useManipulation";
import { exportBodies } from "./io/exporters";
import { ExportDialog, type ExportOptions } from "./io/ExportDialog";
import type { FileMeta } from "./io/fileFormat";
import { downloadBlob, GENERATOR, autosaveProblem, loadAutosave, loadHistory, openDocument, resetFileHandle, saveDocument, writeAutosave, writeHistory } from "./io/storage";

const UNTITLED = "Untitled.openshape";
const newMeta = (): FileMeta => {
  const now = new Date().toISOString();
  return { created: now, modified: now, generator: GENERATOR };
};
const baseName = (f: string) => f.replace(/\.openshape$/i, "") || "model";

/** Re-solves sketches whose dimensions changed through expressions. */
const solveSketch: SketchSolver = (s) => {
  if (!solverReady()) return s;
  const r = solve(s);
  return r.ok && r.conflicting.length === 0 ? r.sketch : null;
};
import { HistoryPanel } from "./ui/HistoryPanel";
import { moveFeature, removeFeatures } from "./model/history";
import { PropertiesPanel } from "./ui/PropertiesPanel";
import { ToolMenus, type Command, type MenuGroup } from "./ui/ToolMenus";
import { Icon } from "./ui/icons";
import { CommandPalette } from "./ui/CommandPalette";
import { fitsBed, loadProfile, saveProfile, type PrinterProfile } from "./print/profile";
import { PrinterDialog } from "./print/PrinterDialog";
import { MeasurePanel } from "./ui/MeasurePanel";
import { regionKey, Viewport, type HoverInfo } from "./viewport/Viewport";

type KernelState = "loading" | "ready" | "error";

/** Undoable document state: one state object, so every transition is a pure function. */
interface DocHistory {
  past: Document[];
  doc: Document;
  future: Document[];
}
const UNDO_LIMIT = 100;

function useDocument(initial: () => { doc: Document; past?: Document[]; future?: Document[] }) {
  const [h, setH] = useState<DocHistory>(() => {
    const s = initial();
    return { past: s.past ?? [], doc: s.doc, future: s.future ?? [] };
  });
  const push = (cur: DocHistory, next: Document): DocHistory =>
    next === cur.doc ? cur : { past: [...cur.past.slice(-(UNDO_LIMIT - 1)), cur.doc], doc: next, future: [] };

  const commit = useCallback((next: Document) => setH((cur) => push(cur, next)), []);
  /** Functional commit: derives the next document from the latest one. */
  const update = useCallback((fn: (cur: Document) => Document) => setH((cur) => push(cur, fn(cur.doc))), []);
  const undo = useCallback(
    () => setH((cur) => (cur.past.length ? { past: cur.past.slice(0, -1), doc: cur.past[cur.past.length - 1], future: [cur.doc, ...cur.future] } : cur)),
    [],
  );
  const redo = useCallback(
    () => setH((cur) => (cur.future.length ? { past: [...cur.past, cur.doc], doc: cur.future[0], future: cur.future.slice(1) } : cur)),
    [],
  );
  /** Loads a different document and starts a fresh undo history. */
  const replace = useCallback((next: Document) => setH({ past: [], doc: next, future: [] }), []);
  return { ...h, commit, update, replace, undo, redo, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}

export function App() {
  const kernel = useRef<KernelClient | null>(null);
  const [kernelState, setKernelState] = useState<KernelState>("loading");
  const [kernelError, setKernelError] = useState("");
  const [kernelThreads, setKernelThreads] = useState(1);
  const [boot] = useState(() => loadAutosave());
  const { doc, past, future, commit: rawCommit, update: rawUpdate, replace, undo, redo, canUndo, canRedo } = useDocument(() => {
    if (!boot) return { doc: demoDocument() };
    // Undo history survives reloads when it was saved for this very document.
    const h = loadHistory(boot.doc);
    return { doc: boot.doc, past: h?.past, future: h?.future };
  });
  const [fileName, setFileName] = useState(boot?.fileName ?? UNTITLED);
  const [meta, setMeta] = useState<FileMeta>(boot?.meta ?? newMeta());
  // The document as last saved to a file; autosaved-only work still counts as unsaved.
  const [savedDoc, setSavedDoc] = useState<Document | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Bumped when a different document is loaded, so the viewport frames it.
  const [fitKey, setFitKey] = useState(0);
  const dirty = doc !== savedDoc;
  // Every edit goes through expression resolution so the kernel sees final numbers.
  const commit = useCallback((next: Document) => rawCommit(resolveDocument(next, solveSketch).doc), [rawCommit]);
  const update = useCallback((fn: (cur: Document) => Document) => rawUpdate((cur) => resolveDocument(fn(cur), solveSketch).doc), [rawUpdate]);
  const resolution = useMemo(() => resolveDocument(doc), [doc]);
  const [editingSketchId, setEditingSketchId] = useState<string | null>(null);
  const [solverState, setSolverState] = useState<KernelState>("loading");
  const [newSketchPlane, setNewSketchPlane] = useState<PlaneName>("XY");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mesh, setMesh] = useState<MeshData | null>(null);
  const [sketchPreviews, setSketchPreviews] = useState<SketchPreview[]>([]);
  const [planePreviews, setPlanePreviews] = useState<PlanePreview[]>([]);
  const [status, setStatus] = useState<Map<string, FeatureStatus>>(new Map());
  const [evalMs, setEvalMs] = useState<number | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  // Kernel busy, and how long the visible "computing" indicator has been up (shown after a short delay).
  const [computing, setComputing] = useState(false);
  const [computingFor, setComputingFor] = useState<number | null>(null);
  useEffect(() => {
    if (!computing) {
      setComputingFor(null);
      return;
    }
    const start = performance.now();
    const show = setTimeout(() => setComputingFor(0), 300);
    const tick = setInterval(() => setComputingFor((v) => (v === null ? v : Math.floor((performance.now() - start) / 1000))), 500);
    return () => {
      clearTimeout(show);
      clearInterval(tick);
    };
  }, [computing]);

  useEffect(() => {
    const k = new KernelClient();
    kernel.current = k;
    k.onReady = (threads) => {
      setKernelThreads(threads);
      setKernelState("ready");
    };
    k.onBusy = setComputing;
    k.onInitError = (e) => {
      setKernelState("error");
      setKernelError(e);
    };
    k.onEvaluated = (r) => {
      setMesh(r.mesh);
      setSketchPreviews(r.sketches);
      setPlanePreviews(r.planes ?? []);
      setStatus(new Map(r.status.map((s) => [s.id, s])));
      setEvalMs(r.ms);
    };
  }, []);

  // Editing a feature that references topology shows the model *before* it,
  // so its edges/faces can be picked: fillet/chamfer (edges), shell and push/pull (faces).
  const selectedFeature = doc.features.find((f) => f.id === selectedId) ?? null;
  const pickingFeature = !editingSketchId && (selectedFeature?.type === "fillet" || selectedFeature?.type === "chamfer" || selectedFeature?.type === "cove") ? selectedFeature : null;
  const faceFeature = !editingSketchId && (selectedFeature?.type === "shell" || selectedFeature?.type === "pushpull" || selectedFeature?.type === "draft" || selectedFeature?.type === "boolean" || selectedFeature?.type === "layflat" || selectedFeature?.type === "teardrop" || selectedFeature?.type === "holefit" || selectedFeature?.type === "insert") ? selectedFeature : null;
  // A draft first asks for its neutral face, then for the faces to tilt.
  const [repickNeutral, setRepickNeutral] = useState(false);
  const pickNeutral = faceFeature?.type === "draft" && (repickNeutral || !faceFeature.neutral);
  const rollbackId = pickingFeature?.id ?? faceFeature?.id;


  // Toolbar commands offered next to the selection (filled in once the menus are built, below).
  const contextRef = useRef<ContextActions>({});
  const manip = useManipulation({
    contextActions: () => contextRef.current,
    doc,
    mesh,
    scope: resolution.scope,
    enabled: !editingSketchId && !pickingFeature && !faceFeature,
    commit: (next) => commit(next),
    onSketchOnFace: (face) => {
      const f = makeSketchOnFace(doc, face);
      add(f);
      manip.clear();
      startSketchEdit(f.id);
    },
    onAddFeature: (f) => add(f),
    sketches: sketchPreviews,
    bodyName: (id) => doc.features.find((f) => f.id === id)?.name ?? "Body",
  });

  // While a handle is dragged the kernel previews the document with the change applied.
  // Measurements of the model selection (faces, edges or a body), computed by the kernel.
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const sel = manip.selection;
  const measureKey = !editingSketchId && !rollbackId && !manip.dragging && (sel.faces.length || sel.edges.length || sel.body) ? JSON.stringify(sel) : null;
  useEffect(() => {
    if (!measureKey || kernelState !== "ready") {
      setMeasurement(null);
      return;
    }
    let alive = true;
    setMeasuring(true);
    const t = setTimeout(() => {
      kernel.current
        ?.measure(doc, JSON.parse(measureKey))
        .then((m) => alive && setMeasurement(m))
        .catch(() => alive && setMeasurement(null))
        .finally(() => alive && setMeasuring(false));
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measureKey, doc, kernelState]);

  // Sketch regions that can still be clicked: those no extrude/revolve uses yet
  // (one that uses a whole sketch takes all of it). None while editing something.
  const pickableRegions = useMemo(() => {
    const out = new Set<string>();
    if (editingSketchId || pickingFeature || faceFeature) return out;
    for (const sk of sketchPreviews) {
      const users = doc.features.filter((f) => !f.suppressed).flatMap((f) => sketchUses(f).filter((u) => u.sketchId === sk.id));
      if (users.some((f) => !f.regions?.length)) continue;
      const used = new Set(users.flatMap((f) => f.regions ?? []));
      for (const r of sk.regions) if (!used.has(r.id)) out.add(regionKey(sk.id, r.id));
    }
    return out;
  }, [sketchPreviews, doc, editingSketchId, pickingFeature, faceFeature]);

  // A revolve or extrude picked in the history gets its ring/arrow on the model.
  useEffect(() => {
    if (selectedFeature?.type === "revolve" || selectedFeature?.type === "extrude") manip.activate(selectedFeature.id);
    else if (selectedId && manip.activeId && manip.activeId !== selectedId) manip.activate(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const kernelDoc = doc;
  useEffect(() => {
    kernel.current?.evaluate(kernelDoc, rollbackId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kernelDoc, rollbackId]);

  useEffect(() => {
    loadSolver().then(
      () => setSolverState("ready"),
      () => setSolverState("error"),
    );
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const selected = doc.features.find((f) => f.id === selectedId) ?? null;
  const sketches = useMemo(() => doc.features.filter((f): f is SketchFeature => f.type === "sketch"), [doc]);
  const baseSketch = selected?.type === "sketch" ? selected : lastSketch(doc);
  // Sweep: the profile is the selected (or latest) sketch with a closed profile, the
  // path the latest other sketch that is one chain of curves. Loft: the sketches with
  // closed profiles nothing uses yet (else the last two).
  const { sweepPair, loftSections } = useMemo(() => {
    const live = sketches.filter((s) => !s.suppressed);
    const closed = live.filter((s) => {
      try {
        return findLoops(s.sketch).loops.length > 0;
      } catch {
        return false;
      }
    });
    const profile = selected?.type === "sketch" && closed.includes(selected) ? selected : closed[closed.length - 1];
    const path = [...live].reverse().find((s) => {
      if (s === profile) return false;
      try {
        sketchPath(s.sketch);
        return !findLoops(s.sketch).loops.length || s.sketch.entities.some((e) => e.kind === "circle");
      } catch {
        return false;
      }
    });
    const used = new Set(doc.features.filter((f) => !f.suppressed).flatMap((f) => sketchUses(f).map((u) => u.sketchId)));
    const free = closed.filter((s) => !used.has(s.id));
    return {
      sweepPair: profile && path ? { profile: profile.id, path: path.id } : null,
      loftSections: (free.length >= 2 ? free : closed.slice(-2)).map((s) => s.id),
    };
  }, [sketches, selected, doc]);
  // Kernel status plus expression errors, which take precedence.
  const fullStatus = useMemo(() => {
    const m = new Map(status);
    for (const [id, error] of resolution.featureErrors) m.set(id, { id, ok: false, error });
    return m;
  }, [status, resolution]);
  const errors = [...fullStatus.values()].filter((s) => !s.ok);

  // Model (3D) or the 2D drawing sheet.
  const [mode, setMode] = useState<"model" | "drawing">("model");
  // Command palette (⌘K).
  const [palette, setPalette] = useState(false);
  // 3D printing: the printer profile (a browser preference) and its settings dialog.
  const [printer, setPrinterState] = useState<PrinterProfile>(loadProfile);
  const setPrinter = (p: PrinterProfile) => {
    setPrinterState(p);
    saveProfile(p);
  };
  const [printerDialog, setPrinterDialog] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const add = (f: Feature) => {
    commit({ ...doc, features: [...doc.features, f] });
    setSelectedId(f.id);
  };

  const editingSketch = doc.features.find((f): f is SketchFeature => f.id === editingSketchId && f.type === "sketch") ?? null;
  // The 2D view of the sketch editor; the 3D camera follows it onto the sketch plane.
  const [sketchView, setSketchView] = useState<{ cx: number; cy: number; scale: number } | null>(null);
  const editingFrame = editingSketch ? sketchPreviews.find((p) => p.id === editingSketch.id)?.frame : undefined;
  const startSketchEdit = (id: string) => {
    if (solverState !== "ready") return;
    setSelectedId(id);
    setEditingSketchId(id);
  };
  // Faces in the displayed mesh and whether they're planar (used while editing a feature).
  const faceInfo = useMemo(() => new Map((mesh?.faceNames ?? []).map((n, i) => [n, mesh!.facePlanar[i]] as const)), [mesh]);
  const cylindrical = useMemo(() => new Set((mesh?.faceNames ?? []).filter((_, i) => mesh!.faceCylindrical?.[i])), [mesh]);
  const liveFaces = manip.selection.faces;
  const singlePlanarFace = manip.singlePlanarFace;

  // A construction plane picked in the history or the viewport: new sketches go on it.
  const selectedPlane = selectedFeature?.type === "plane" ? selectedFeature.id : null;
  const newSketch = () => {
    // On the selected construction plane, or a single selected planar face, or the chosen standard plane.
    const f = selectedPlane ? makeSketchOnPlane(doc, selectedPlane) : singlePlanarFace ? makeSketchOnFace(doc, singlePlanarFace) : makeSketch(doc, newSketchPlane);
    add(f);
    manip.clear();
    startSketchEdit(f.id);
  };

  // Bodies of the shown model, with their names (the feature that created each).
  const bodyList = useMemo(() => {
    const ids = [...new Set(mesh?.faceBody ?? [])];
    return ids.map((id) => ({ id, name: doc.features.find((f) => f.id === id)?.name ?? "Body" }));
  }, [mesh, doc.features]);
  const bodyOfFace = (name: string) => {
    const i = mesh?.faceNames.indexOf(name) ?? -1;
    return i >= 0 ? mesh!.faceBody[i] : null;
  };

  const onPickFace = (name: string | null, additive: boolean) => {
    if (faceFeature?.type === "boolean") {
      const body = name ? bodyOfFace(name) : null;
      if (!body) return;
      // The first body picked is the target; the next ones are tools (click again to drop one).
      if (!faceFeature.target) return commit(updateFeature(doc, faceFeature.id, { target: body, tools: faceFeature.tools.filter((t) => t !== body) }));
      if (body === faceFeature.target) return flash("That's the target body: pick the bodies to combine with it");
      const tools = faceFeature.tools.includes(body) ? faceFeature.tools.filter((t) => t !== body) : [...faceFeature.tools, body];
      commit(updateFeature(doc, faceFeature.id, { tools }));
      return;
    }
    if (faceFeature?.type === "shell") {
      if (!name) return;
      const faces = faceFeature.faces.includes(name) ? faceFeature.faces.filter((n) => n !== name) : [...faceFeature.faces, name];
      commit(updateFeature(doc, faceFeature.id, { faces }));
      return;
    }
    if (faceFeature?.type === "draft") {
      if (!name) return;
      if (pickNeutral) {
        if (!faceInfo.get(name)) return flash("The neutral face must be planar");
        commit(updateFeature(doc, faceFeature.id, { neutral: name, faces: faceFeature.faces.filter((n) => n !== name) }));
        setRepickNeutral(false);
        return;
      }
      if (name === faceFeature.neutral) return flash("That's the neutral face: it stays fixed");
      const faces = faceFeature.faces.includes(name) ? faceFeature.faces.filter((n) => n !== name) : [...faceFeature.faces, name];
      commit(updateFeature(doc, faceFeature.id, { faces }));
      return;
    }
    if (faceFeature?.type === "teardrop" || faceFeature?.type === "holefit" || faceFeature?.type === "insert") {
      if (!name) return;
      if (!cylindrical.has(name)) return flash("Pick the hole's cylindrical face");
      const faces = faceFeature.faces.includes(name) ? faceFeature.faces.filter((n) => n !== name) : [...faceFeature.faces, name];
      commit(updateFeature(doc, faceFeature.id, { faces }));
      return;
    }
    if (faceFeature?.type === "layflat") {
      if (name && faceInfo.get(name)) commit(updateFeature(doc, faceFeature.id, { face: name }));
      else if (name) flash("Lay flat needs a planar face");
      return;
    }
    if (faceFeature?.type === "pushpull") {
      if (name && faceInfo.get(name)) commit(updateFeature(doc, faceFeature.id, { face: name }));
      else if (name) flash("Push/Pull needs a planar face");
      return;
    }
    manip.pickFace(name, additive);
    if (selectedFeature) setSelectedId(null);
  };

  const importFile = () => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: ".step,.stp,.stl" });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const format = /\.stl$/i.test(file.name) ? "stl" : "step";
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      add(makeImport(file.name, format, btoa(bin), hasBody(doc) ? "join" : "new"));
      flash(`Imported ${file.name}`);
    };
    input.click();
  };

  const deleteFeature = (id: string) => {
    commit(removeFeature(doc, id));
    if (selectedId === id) setSelectedId(null);
  };

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((n) => (n === msg ? null : n)), 4000);
  };

  // Export: format, bodies, one file or one per body, mesh quality (from the export dialog).
  const [exportDialog, setExportDialog] = useState(false);
  const exportWith = async (o: ExportOptions) => {
    const k = kernel.current!;
    const name = baseName(fileName);
    const bodyLabel = (id: string) => doc.features.find((f) => f.id === id)?.name ?? "Body";
    // A single body exported alone is named after it.
    const fileBase = o.bodies.length === 1 ? `${name} - ${bodyLabel(o.bodies[0])}` : name;
    try {
      if (o.format === "step") {
        downloadBlob(await k.exportSTEP(doc, o.bodies), `${fileBase}.step`);
        return flash(`Exported ${fileBase}.step`);
      }
      const parts = await k.exportMesh(doc, o.bodies, o.quality);
      const { blob, fileName: out } = await exportBodies(
        parts.map((p) => ({ name: bodyLabel(p.id), mesh: p })),
        o.format,
        fileBase,
        o.separate,
      );
      downloadBlob(blob, out);
      flash(`Exported ${out}`);
    } catch (e) {
      flash(`Export failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  // ---- file commands ----------------------------------------------------------
  const confirmDiscard = () => !dirty || window.confirm("Discard unsaved changes?");

  const newDocument = () => {
    if (!confirmDiscard()) return;
    replace({ variables: [], features: [] });
    setFitKey((k) => k + 1);
    setFileName(UNTITLED);
    setMeta(newMeta());
    setSavedDoc(null);
    setSelectedId(null);
    setEditingSketchId(null);
    resetFileHandle();
  };

  const open = async () => {
    if (!confirmDiscard()) return;
    try {
      const r = await openDocument();
      if (!r) return;
      const resolved = resolveDocument(r.doc, solveSketch).doc;
      replace(resolved);
      setFitKey((k) => k + 1);
      setSavedDoc(resolved);
      setFileName(r.fileName);
      setMeta(r.meta);
      setSelectedId(null);
      setEditingSketchId(null);
      flash(`Opened ${r.fileName}`);
    } catch (e) {
      flash(`Can't open file: ${e instanceof Error ? e.message : e}`);
    }
  };

  const save = async (saveAs = false) => {
    const m = { ...meta, modified: new Date().toISOString(), generator: GENERATOR };
    try {
      const name = await saveDocument(doc, m, fileName, saveAs);
      if (!name) return;
      setMeta(m);
      setFileName(name);
      setSavedDoc(doc);
      flash(`Saved ${name}`);
    } catch (e) {
      flash(`Save failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  useEffect(() => {
    if (autosaveProblem) flash(`The autosaved document could not be opened (${autosaveProblem}); a copy was kept in browser storage.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosave to the browser so a reload never loses work.
  useEffect(() => {
    const t = setTimeout(() => writeAutosave(doc, { ...meta, modified: new Date().toISOString() }, fileName), 400);
    return () => clearTimeout(t);
  }, [doc, meta, fileName]);
  useEffect(() => {
    const t = setTimeout(() => writeHistory(doc, past, future), 600);
    return () => clearTimeout(t);
  }, [doc, past, future]);

  useEffect(() => {
    document.title = `${dirty ? "• " : ""}${baseName(fileName)} – OpenShape`;
  }, [dirty, fileName]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        save(e.shiftKey);
      } else if (k === "o") {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Delete / Backspace removes the feature selected in the history (not while typing or sketching).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) return;
      const s = manip.selection;
      if (editingSketchId || !selectedId || s.faces.length || s.edges.length || s.body || s.regions.length) return;
      e.preventDefault();
      deleteFeature(selectedId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });


  // ---- toolbar menus ------------------------------------------------------------
  const fileMenus: MenuGroup[] = [
    {
      id: "file",
      label: "File",
      icon: "menu",
      items: [
        { id: "new", label: "New", icon: "new", run: newDocument },
        { id: "open", label: "Open…", icon: "open", shortcut: "⌘O", run: open },
        { id: "save", label: "Save", icon: "save", shortcut: "⌘S", run: () => save(false) },
        { id: "saveas", label: "Save as…", icon: "saveAs", shortcut: "⇧⌘S", run: () => save(true) },
        "separator",
        { id: "import", label: "Import STEP or STL…", icon: "import", run: importFile },
        {
          id: "export",
          label: "Export…",
          icon: "export" as const,
          title: "STL, 3MF, STEP, OBJ, PLY, glTF: all bodies or some, one file or one per body",
          disabled: kernelState !== "ready" || !mesh,
          run: () => setExportDialog(true),
        },
      ],
    },
  ];
  const modeling = mode === "model";
  const toolMenus: MenuGroup[] = [
    {
      id: "sketch",
      label: "Sketch",
      icon: "sketch",
      hidden: !modeling,
      items: [
        {
          id: "sketch",
          label: selectedPlane ? "Sketch on plane" : singlePlanarFace ? "Sketch on face" : `Sketch on ${newSketchPlane}`,
          icon: "sketch",
          disabled: solverState !== "ready" || !!editingSketch,
          title: "New sketch: on the selected construction plane or planar face, else on the plane chosen below",
          run: newSketch,
        },
        { heading: "Plane for new sketches" },
        ...(["XY", "XZ", "YZ"] as PlaneName[]).map((p) => ({
          id: `plane-${p}`,
          label: p === "XY" ? "XY (top)" : p === "XZ" ? "XZ (front)" : "YZ (right)",
          checked: newSketchPlane === p,
          disabled: !!editingSketch,
          run: () => setNewSketchPlane(p),
        })),
      ],
    },
    {
      id: "create",
      label: "Create",
      icon: "extrude",
      hidden: !modeling || !!editingSketch,
      items: [
        { id: "extrude", label: "Extrude", icon: "extrude", disabled: !baseSketch, title: "Extrude the selected (or latest) sketch", run: () => add(makeExtrude(doc, baseSketch!.id, hasBody(doc) ? "join" : "new")) },
        { id: "revolve", label: "Revolve", icon: "revolve", disabled: !baseSketch, title: "Revolve the sketch: pick the axis next", run: () => (setSelectedId(null), manip.startRevolve(baseSketch!.id)) },
        {
          id: "sweep",
          label: "Sweep",
          icon: "sweep",
          disabled: !sweepPair,
          title: sweepPair ? "Move a sketch profile along the path drawn in another sketch" : "Needs a sketch with a closed profile and another one with a path (a chain of curves)",
          run: () => add(makeSweep(doc, sweepPair!.profile, sweepPair!.path, hasBody(doc) ? "join" : "new")),
        },
        {
          id: "loft",
          label: "Loft",
          icon: "loft",
          disabled: loftSections.length < 2,
          title: loftSections.length < 2 ? "Needs two or more sketches with closed profiles" : "A solid through the closed profiles of several sketches",
          run: () => add(makeLoft(doc, loftSections, hasBody(doc) ? "join" : "new")),
        },
      ],
    },
    {
      id: "modify",
      label: "Modify",
      icon: "pushpull",
      hidden: !modeling || !!editingSketch,
      items: [
        { id: "fillet", label: "Fillet", icon: "fillet", disabled: !hasBody(doc), title: "Round edges (click them next, or select them first)", run: () => add({ ...makeEdgeTreatment(doc, "fillet"), edges: sel.edges }) },
        { id: "chamfer", label: "Chamfer", icon: "chamfer", disabled: !hasBody(doc), title: "Bevel edges", run: () => add({ ...makeEdgeTreatment(doc, "chamfer"), edges: sel.edges }) },
        { id: "cove", label: "Cove", icon: "cove", disabled: !sel.edges.length, title: sel.edges.length ? "Concave quarter-round groove on the selected edges" : "Select straight or circular edges first", run: () => (add(makeCove(doc, sel.edges)), manip.clear()) },
        "separator",
        { id: "pushpull", label: "Push/Pull", icon: "pushpull", disabled: !singlePlanarFace, title: singlePlanarFace ? "Move the selected planar face along its normal" : "Select one planar face first", run: () => (add(makePushPull(doc, singlePlanarFace!)), manip.clear()) },
        { id: "shell", label: "Shell", icon: "shell", disabled: !hasBody(doc), title: "Hollow the body; selected faces become openings", run: () => (add(makeShell(doc, liveFaces)), manip.clear()) },
        { id: "draft", label: "Draft", icon: "draft", disabled: !hasBody(doc), title: "Tilt faces by an angle (moulded parts): pick the neutral face, then the faces", run: () => (add(makeDraft(doc, liveFaces)), setRepickNeutral(false), manip.clear()) },
      ],
    },
    {
      id: "combine",
      label: "Combine",
      icon: "boolean",
      hidden: !modeling || !!editingSketch,
      items: [
        {
          id: "boolean",
          label: "Boolean",
          icon: "boolean",
          disabled: bodyList.length < 2,
          title: bodyList.length < 2 ? "Needs two or more bodies" : "Join, subtract or intersect bodies: pick the target, then the others",
          run: () => (add(makeBoolean(doc, sel.body ?? "")), manip.clear()),
        },
        { id: "mirror", label: "Mirror", icon: "mirror", disabled: !hasBody(doc), title: "Mirror the body across a plane", run: () => add(makeMirror(doc)) },
        { id: "pattern", label: "Pattern", icon: "pattern", disabled: !hasBody(doc), title: "Repeat the body (linear or circular)", run: () => add(makePattern(doc)) },
      ],
    },
    {
      id: "construct",
      label: "Construct",
      icon: "plane",
      hidden: !modeling || !!editingSketch,
      items: [
        {
          id: "plane",
          label: "Plane",
          icon: "plane",
          title: "From the selection: a planar face (offset), two parallel faces (midplane), a face and an edge (angle), an edge (normal), or nothing (offset from the sketch plane)",
          run: () => {
            const faces = sel.faces.filter((n) => faceInfo.get(n));
            const init =
              faces.length >= 2
                ? { mode: "midplane" as const, face: faces[0], face2: faces[1] }
                : faces.length === 1 && sel.edges.length
                  ? { mode: "angle" as const, face: faces[0], edge: sel.edges[0] }
                  : faces.length === 1
                    ? { mode: "offset" as const, face: faces[0] }
                    : sel.edges.length
                      ? { mode: "normal" as const, edge: sel.edges[0], position: 0.5 }
                      : { mode: "offset" as const, base: newSketchPlane };
            add(makePlane(doc, init));
            manip.clear();
          },
        },
      ],
    },
    {
      id: "print",
      label: "Print",
      icon: "print",
      hidden: !modeling || !!editingSketch,
      items: [
        { id: "printer", label: "Printer settings…", icon: "print", title: "Build volume, nozzle, material and price", run: () => setPrinterDialog(true) },
        { id: "showbed", label: "Show the bed", checked: printer.showBed, run: () => setPrinter({ ...printer, showBed: !printer.showBed }) },
        "separator",
        {
          id: "teardrop",
          label: "Teardrop holes",
          icon: "teardrop",
          disabled: !hasBody(doc),
          title: "A 45° roof over horizontal holes, so they print without supports (select the holes, or click them next)",
          run: () => (add(makeTeardrop(doc, sel.faces.filter((n) => cylindrical.has(n)))), manip.clear()),
        },
        {
          id: "holefit",
          label: "Hole compensation",
          icon: "holefit",
          disabled: !hasBody(doc),
          title: "Widen holes a little: printed holes come out small (select the holes, or click them next)",
          run: () => (add(makeHoleFit(doc, sel.faces.filter((n) => cylindrical.has(n)))), manip.clear()),
        },
        {
          id: "insert",
          label: "Insert seats",
          icon: "insert",
          disabled: !hasBody(doc),
          title: "Seats for heat-set threaded inserts (M2–M5) in holes, from their opening (select the pilot holes, or click them next)",
          run: () => (add(makeInsert(doc, sel.faces.filter((n) => cylindrical.has(n)))), manip.clear()),
        },
        { id: "layflat", label: "Lay flat", icon: "layflat", disabled: !singlePlanarFace, title: singlePlanarFace ? "Turn the body so the selected planar face lies on the bed" : "Select one planar face first", run: () => (add(makeLayFlat(doc, singlePlanarFace!)), manip.clear()) },
        { heading: "Overhangs: Inspect, top right of the view" },
      ],
    },
  ];
  // The print bed under the whole model, and whether the model fits the build volume.
  const bed = useMemo(() => {
    if (!printer.showBed || !mesh || !mesh.vertices.length) return null;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.vertices.length; i += 3)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], mesh.vertices[i + k]);
        hi[k] = Math.max(hi[k], mesh.vertices[i + k]);
      }
    const size = [0, 1, 2].map((k) => hi[k] - lo[k]) as [number, number, number];
    return { size: printer.bed, model: size, center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2] as [number, number], fits: fitsBed(size, printer.bed) };
  }, [printer.showBed, printer.bed, mesh]);
  const commandById = (id: string) => toolMenus.flatMap((g) => g.items).find((i): i is Command => typeof i === "object" && "run" in i && i.id === id);
  const pick = (...ids: string[]) => ids.map(commandById).filter((c): c is Command => !!c);
  contextRef.current = {
    face: pick("plane", "layflat", "draft"),
    cylinder: pick("teardrop", "holefit", "insert"),
    faces: pick("plane"),
    edge: pick("plane"),
    body: bodyList.length > 1 ? pick("boolean", "mirror", "pattern") : pick("mirror", "pattern"),
  };

  return (
    <div className={`app${kernelState === "ready" && computingFor !== null ? " computing" : ""}`}>
      <header className="toolbar">
        <strong className="brand">OpenShape</strong>
        <ToolMenus groups={fileMenus} />
        <div className="group mode-switch">
          <button className={mode === "model" ? "active" : ""} onClick={() => setMode("model")} title="Model the part in 3D">
            <Icon name="model" /> Model
          </button>
          <button className={mode === "drawing" ? "active" : ""} disabled={!!editingSketch} onClick={() => (setMode("drawing"), manip.clear())} title="2D technical drawing of the model: views, dimensions, PDF/DXF export">
            <Icon name="drawing" /> Drawing
          </button>
        </div>
        <ToolMenus groups={toolMenus} />
        <button className="palette-button" onClick={() => setPalette(true)} title="Find a command (⌘K)">
          <Icon name="search" /> <span className="palette-hint">⌘K</span>
        </button>
        <div className="group right">
          <button disabled={!canUndo} onClick={undo} title="Undo (⌘Z)" aria-label="Undo">
            <Icon name="undo" />
          </button>
          <button disabled={!canRedo} onClick={redo} title="Redo (⇧⌘Z)" aria-label="Redo">
            <Icon name="redo" />
          </button>
        </div>
      </header>
      {exportDialog && <ExportDialog bodies={bodyList} preselected={sel.body} onExport={exportWith} onClose={() => setExportDialog(false)} />}
      {printerDialog && <PrinterDialog profile={printer} onChange={setPrinter} onClose={() => setPrinterDialog(false)} />}
      {palette && <CommandPalette groups={[...fileMenus, ...toolMenus]} onClose={() => setPalette(false)} />}

      <div className="sidebar">
      <div className="doc-header">
        <button className="doc-name" onClick={() => save(true)} title="Rename: save under another name (⇧⌘S)">
          {baseName(fileName)}
          {dirty && <span className="dirty">•</span>}
        </button>
        <span className="doc-state" title={dirty ? "Not saved to a file yet; the browser keeps an automatic copy" : undefined}>
          {dirty ? "Unsaved changes" : "Saved"}
        </span>
      </div>
      <HistoryPanel
        features={doc.features}
        status={fullStatus}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onEdit={(id) => doc.features.find((f) => f.id === id)?.type === "sketch" && startSketchEdit(id)}
        onToggle={(id) => {
          const f = doc.features.find((x) => x.id === id)!;
          commit(updateFeature(doc, id, { suppressed: !f.suppressed }));
        }}
        onDelete={deleteFeature}
        onMove={(id, to) => {
          const r = moveFeature(doc, id, to);
          if (!r.ok) flash(`Can't move: ${r.reason}`);
          else if (r.doc !== doc) commit(r.doc);
        }}
        onDeleteErrors={(ids) => {
          commit(removeFeatures(doc, ids));
          if (selectedId && ids.includes(selectedId)) setSelectedId(null);
          flash(`Deleted ${ids.length} feature${ids.length > 1 ? "s" : ""}`);
        }}
      />

        <VariablesPanel
          variables={doc.variables}
          errors={resolution.variableErrors}
          scope={resolution.scope}
          onChange={(variables) => update((cur) => ({ ...cur, variables }))}
        />
      </div>

      {mode === "drawing" ? (
        <DrawingWorkspace doc={doc} commit={commit} project={(d, dirs) => kernel.current!.project(d, dirs)} name={baseName(fileName)} flash={flash} />
      ) : (
      <>
      <main className="stage">
        <Viewport
          mesh={mesh}
          sketches={sketchPreviews}
          selectedSketchId={selected?.type === "sketch" ? selected.id : null}
          onHover={setHover}
          edgesOnly={!!pickingFeature}
          selectedEdges={pickingFeature?.edges ?? manip.selection.edges}
          onPickEdge={(name, additive) => {
            if (!pickingFeature) {
              manip.pickEdge(name, additive);
              if (selectedFeature) setSelectedId(null);
              return;
            }
            const has = pickingFeature.edges.includes(name);
            const edges = has ? pickingFeature.edges.filter((e) => e !== name) : [...pickingFeature.edges, name];
            commit(updateFeature(doc, pickingFeature.id, { edges }));
          }}
          selectedFaces={
            faceFeature?.type === "shell" || faceFeature?.type === "teardrop" || faceFeature?.type === "holefit" || faceFeature?.type === "insert"
              ? faceFeature.faces
              : faceFeature?.type === "pushpull" || faceFeature?.type === "layflat"
                ? [faceFeature.face]
                : faceFeature?.type === "draft"
                  ? pickNeutral
                    ? []
                    : [...faceFeature.faces, ...(faceFeature.neutral ? [faceFeature.neutral] : [])]
                  : faceFeature?.type === "boolean"
                    ? (mesh?.faceNames.filter((_, i) => faceFeature.tools.includes(mesh.faceBody[i])) ?? [])
                    : liveFaces
          }
          selectedBody={faceFeature?.type === "boolean" ? faceFeature.target || null : manip.selection.body}
          onPickFace={onPickFace}
          pickableRegions={pickableRegions}
          axisCandidates={manip.axisCandidates}
          onPickAxis={manip.pickAxis}
          selectedRegions={manip.selection.regions.map((r) => regionKey(r.sketch, r.id))}
          onPickRegion={(sketch, id, additive) => {
            manip.pickRegion(sketch, id, additive);
            if (selectedFeature) setSelectedId(null);
          }}
          onEditSketch={(id) => solverState === "ready" && startSketchEdit(id)}
          planes={editingSketch ? [] : planePreviews}
          bed={editingSketch ? null : bed}
          selectedPlane={selectedPlane}
          onPickPlane={(id) => {
            manip.clear();
            setSelectedId(id);
          }}
          onPickBody={(id) => {
            if (faceFeature || pickingFeature) return;
            manip.pickBody(id);
            if (selectedFeature) setSelectedId(null);
          }}
          handles={manip.handles}
          onHandleDrag={manip.onHandleDrag}
          overlay={manip.overlay}
          rigidPreview={manip.rigid}
          fitKey={fitKey}
          ghost={manip.ghost}
          sweep={manip.sweep}
          hiddenFaces={manip.hiddenFaces}
          sketchCamera={editingSketch && sketchView && editingFrame ? { frame: editingFrame, ...sketchView } : null}
          hiddenSketchId={editingSketch?.id ?? null}
        />
        {measureKey && <MeasurePanel measurement={measurement} busy={measuring} printer={printer} />}
        {editingSketch && (
          <SketchEditor
            key={editingSketch.id}
            feature={editingSketch}
            scope={resolution.scope}
            reference={sketchPreviews.find((p) => p.id === editingSketch.id)?.reference}
            onCommit={(sketch) => update((cur) => updateFeature(cur, editingSketch.id, { sketch }))}
            onExit={() => {
              setEditingSketchId(null);
              setSketchView(null);
            }}
            onViewChange={setSketchView}
          />
        )}
        {pickingFeature && (
          <div className="overlay picking-banner">
            Click edges to {pickingFeature.type} · showing the model before <strong>{pickingFeature.name}</strong>
          </div>
        )}
        {bed && !bed.fits && !editingSketch && (
          <div className="overlay bed-warning" role="status">
            The model ({bed.model.map((v) => Math.round(v)).join(" × ")} mm) doesn't fit the build volume ({bed.size.join(" × ")} mm)
          </div>
        )}
        {faceFeature && (
          <div className="overlay picking-banner">
            {faceFeature.type === "shell"
              ? "Click faces to open"
              : faceFeature.type === "draft"
                ? pickNeutral
                  ? "Click the neutral face (its plane stays fixed)"
                  : "Click faces to draft"
                : faceFeature.type === "layflat"
                  ? "Click the planar face to put on the bed"
                  : faceFeature.type === "teardrop" || faceFeature.type === "holefit" || faceFeature.type === "insert"
                  ? "Click the holes (their cylindrical faces)"
                  : faceFeature.type === "boolean"
                  ? !faceFeature.target
                    ? "Click the target body"
                    : `Click bodies to ${faceFeature.op === "join" ? "join to it" : faceFeature.op === "cut" ? "subtract from it" : "intersect with it"}`
                  : "Click the planar face to move"}{" "}
            · showing the model before <strong>{faceFeature.name}</strong>
          </div>
        )}
        {kernelState === "loading" && (
          <div className="overlay busy-indicator" role="status">
            <span className="spinner" aria-hidden="true" /> Loading the modeling kernel…
          </div>
        )}
        {kernelState === "ready" && computingFor !== null && (
          <div className="overlay busy-indicator" role="status" title="The solid is being rebuilt">
            <span className="spinner" aria-hidden="true" /> Computing{computingFor >= 2 ? ` · ${computingFor} s` : "…"}
          </div>
        )}
        {kernelState === "error" && <div className="overlay error-msg">Kernel unavailable: {kernelError}</div>}
      </main>

      <PropertiesPanel
        feature={selected}
        sketches={sketches}
        status={selected ? fullStatus.get(selected.id) : undefined}
        scope={resolution.scope}
        onChange={(patch) => selected && commit(updateFeature(doc, selected.id, patch))}
        onEditSketch={startSketchEdit}
        canEditSketch={solverState === "ready" && !editingSketch}
        bodies={bodyList}
        onSketchOnPlane={(id) => {
          const f = makeSketchOnPlane(doc, id);
          add(f);
          startSketchEdit(f.id);
        }}
        onPickNeutral={() => setRepickNeutral(true)}
        pickingNeutral={pickNeutral}
      />
      </>
      )}

      <footer className="statusbar">
        <span title={kernelThreads > 1 ? "Multi-threaded OpenCascade: Booleans run in parallel" : "Single-threaded OpenCascade (the page isn't cross-origin isolated)"}>
          Kernel: {kernelState}
          {kernelState === "ready" && (kernelThreads > 1 ? ` · ${kernelThreads} threads` : " · 1 thread")}
        </span>
        <span>Solver: {solverState}</span>
        {evalMs != null && <span>Rebuild: {evalMs.toFixed(0)} ms</span>}
        <span className="topo-name" title="Persistent topological name">
          {hover?.edge ? `Edge ${hover.edge}` : hover?.face ? `Face ${hover.face}` : "—"}
        </span>
        {errors.length > 0 && <span className="error-msg">{errors.length} errors in history</span>}
        {notice && <span className="notice">{notice}</span>}
      </footer>
    </div>
  );
}
