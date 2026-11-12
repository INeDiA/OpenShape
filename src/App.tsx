import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KernelClient } from "./kernel/client";
import {
  demoDocument,
  hasBody,
  lastSketch,
  makeEdgeTreatment,
  makeExtrude,
  makeImport,
  makeMirror,
  makePattern,
  makePushPull,
  makeShell,
  makeSketch,
  makeSketchOnFace,
  removeFeature,
  updateFeature,
} from "./model/doc";
import type { Document, Feature, FeatureStatus, Measurement, MeshData, PlaneName, SketchFeature, SketchPreview } from "./model/types";
import { SketchEditor } from "./sketch/SketchEditor";
import { loadSolver, solve, solverReady } from "./sketch/solver";
import { resolveDocument, type SketchSolver } from "./model/resolve";
import { VariablesPanel } from "./ui/VariablesPanel";
import { useManipulation } from "./ui/useManipulation";
import { EXPORT_FORMATS, exportMesh, type ExportFormat } from "./io/exporters";
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
      setStatus(new Map(r.status.map((s) => [s.id, s])));
      setEvalMs(r.ms);
    };
  }, []);

  // Editing a feature that references topology shows the model *before* it,
  // so its edges/faces can be picked: fillet/chamfer (edges), shell and push/pull (faces).
  const selectedFeature = doc.features.find((f) => f.id === selectedId) ?? null;
  const pickingFeature = !editingSketchId && (selectedFeature?.type === "fillet" || selectedFeature?.type === "chamfer" || selectedFeature?.type === "cove") ? selectedFeature : null;
  const faceFeature = !editingSketchId && (selectedFeature?.type === "shell" || selectedFeature?.type === "pushpull") ? selectedFeature : null;
  const rollbackId = pickingFeature?.id ?? faceFeature?.id;


  const manip = useManipulation({
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
      const users = doc.features.filter((f) => (f.type === "extrude" || f.type === "revolve") && f.sketchId === sk.id && !f.suppressed) as { regions?: string[] }[];
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
  // Kernel status plus expression errors, which take precedence.
  const fullStatus = useMemo(() => {
    const m = new Map(status);
    for (const [id, error] of resolution.featureErrors) m.set(id, { id, ok: false, error });
    return m;
  }, [status, resolution]);
  const errors = [...fullStatus.values()].filter((s) => !s.ok);

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
  const liveFaces = manip.selection.faces;
  const singlePlanarFace = manip.singlePlanarFace;

  const newSketch = () => {
    // With one planar face selected, sketch on it; otherwise on the chosen standard plane.
    const f = singlePlanarFace ? makeSketchOnFace(doc, singlePlanarFace) : makeSketch(doc, newSketchPlane);
    add(f);
    manip.clear();
    startSketchEdit(f.id);
  };

  const onPickFace = (name: string | null, additive: boolean) => {
    if (faceFeature?.type === "shell") {
      if (!name) return;
      const faces = faceFeature.faces.includes(name) ? faceFeature.faces.filter((n) => n !== name) : [...faceFeature.faces, name];
      commit(updateFeature(doc, faceFeature.id, { faces }));
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

  const exportAs = async (format: ExportFormat) => {
    const k = kernel.current!;
    const info = EXPORT_FORMATS.find((f) => f.id === format)!;
    const name = baseName(fileName);
    try {
      const blob = format === "step" ? await k.exportSTEP(doc) : await exportMesh(await k.exportMesh(doc), format, name);
      downloadBlob(blob, `${name}.${info.ext}`);
      flash(`Exported ${name}.${info.ext}`);
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


  return (
    <div className={`app${kernelState === "ready" && computingFor !== null ? " computing" : ""}`}>
      <header className="toolbar">
        <strong className="brand">OpenShape</strong>
        <div className="group file-group">
          <button onClick={newDocument} title="New document">New</button>
          <button onClick={open} title="Open (⌘O)">Open</button>
          <button onClick={() => save(false)} title="Save (⌘S)">Save</button>
          <button onClick={() => save(true)} title="Save as (⇧⌘S)">Save as</button>
          <span className="doc-name" title={dirty ? "Unsaved changes (autosaved in this browser)" : "Saved"}>
            {baseName(fileName)}
            {dirty && <span className="dirty">•</span>}
          </span>
        </div>
        <div className="group">
          <button
            disabled={solverState !== "ready" || !!editingSketch}
            onClick={newSketch}
            title={singlePlanarFace ? "New sketch on the selected face" : "New sketch on the chosen plane (select a planar face to sketch on it)"}
          >
            {singlePlanarFace ? "✎ Sketch on face" : "✎ Sketch"}
          </button>
          <select value={newSketchPlane} onChange={(e) => setNewSketchPlane(e.target.value as PlaneName)} disabled={!!editingSketch || !!singlePlanarFace} title="Sketch plane">
            <option value="XY">XY (top)</option>
            <option value="XZ">XZ (front)</option>
            <option value="YZ">YZ (right)</option>
          </select>
        </div>
        <div className={`group${editingSketch ? " hidden" : ""}`}>
          <button disabled={!baseSketch} onClick={() => add(makeExtrude(doc, baseSketch!.id, hasBody(doc) ? "join" : "new"))}>
            ⬆ Extrude
          </button>
          <button disabled={!baseSketch} onClick={() => (setSelectedId(null), manip.startRevolve(baseSketch!.id))} title="Revolve the sketch: pick the axis next">
            ↻ Revolve
          </button>
          <button disabled={!hasBody(doc)} onClick={() => add(makeEdgeTreatment(doc, "fillet"))}>◜ Fillet</button>
          <button disabled={!hasBody(doc)} onClick={() => add(makeEdgeTreatment(doc, "chamfer"))}>◸ Chamfer</button>
        </div>
        <div className={`group${editingSketch ? " hidden" : ""}`}>
          <button
            disabled={!singlePlanarFace}
            title="Move the selected planar face along its normal"
            onClick={() => {
              add(makePushPull(doc, singlePlanarFace!));
              manip.clear();
            }}
          >
            ⇕ Push/Pull
          </button>
          <button
            disabled={!hasBody(doc)}
            title="Hollow the body; selected faces become openings"
            onClick={() => {
              add(makeShell(doc, liveFaces));
              manip.clear();
            }}
          >
            ▢ Shell
          </button>
          <button disabled={!hasBody(doc)} onClick={() => add(makeMirror(doc))} title="Mirror the body across a plane">
            ⇋ Mirror
          </button>
          <button disabled={!hasBody(doc)} onClick={() => add(makePattern(doc))} title="Repeat the body (linear or circular)">
            ⁘ Pattern
          </button>
          <button onClick={importFile} title="Import a STEP or STL file">
            ⇩ Import
          </button>
        </div>
        <div className="group">
          <button disabled={!canUndo} onClick={undo} title="⌘Z">↶</button>
          <button disabled={!canRedo} onClick={redo} title="⇧⌘Z">↷</button>
        </div>
        <div className="group right">
          <select
            className="export-select"
            value=""
            disabled={kernelState !== "ready" || !mesh}
            onChange={(e) => e.target.value && exportAs(e.target.value as ExportFormat)}
            title="Export the current body"
          >
            <option value="">Export…</option>
            {EXPORT_FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label} – {f.hint}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="sidebar">
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
          selectedFaces={faceFeature?.type === "shell" ? faceFeature.faces : faceFeature?.type === "pushpull" ? [faceFeature.face] : liveFaces}
          selectedBody={manip.selection.body}
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
        {measureKey && <MeasurePanel measurement={measurement} busy={measuring} />}
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
        {faceFeature && (
          <div className="overlay picking-banner">
            {faceFeature.type === "shell" ? "Click faces to open" : "Click the planar face to move"} · showing the model before <strong>{faceFeature.name}</strong>
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
      />

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
