import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KernelClient } from "./kernel/client";
import {
  demoDocument,
  hasBody,
  lastSketch,
  makeEdgeTreatment,
  makeExtrude,
  makeRevolve,
  makeSketch,
  removeFeature,
  updateFeature,
} from "./model/doc";
import type { Document, Feature, FeatureStatus, MeshData, PlaneName, SketchFeature, SketchPreview } from "./model/types";
import { SketchEditor } from "./sketch/SketchEditor";
import { loadSolver } from "./sketch/solver";
import { HistoryPanel } from "./ui/HistoryPanel";
import { PropertiesPanel } from "./ui/PropertiesPanel";
import { Viewport } from "./viewport/Viewport";

type KernelState = "loading" | "ready" | "error";

/** Undoable document state. */
function useDocument(initial: () => Document) {
  const [past, setPast] = useState<Document[]>([]);
  const [doc, setDoc] = useState<Document>(initial);
  const [future, setFuture] = useState<Document[]>([]);

  const commit = useCallback((next: Document) => {
    setDoc((cur) => {
      setPast((p) => [...p.slice(-99), cur]);
      return next;
    });
    setFuture([]);
  }, []);
  /** Functional commit: derives the next document from the latest one. */
  const update = useCallback((fn: (cur: Document) => Document) => {
    setDoc((cur) => {
      const next = fn(cur);
      if (next === cur) return cur;
      setPast((p) => [...p.slice(-99), cur]);
      return next;
    });
    setFuture([]);
  }, []);
  const undo = useCallback(() => {
    setPast((p) => {
      if (!p.length) return p;
      setDoc((cur) => {
        setFuture((f) => [cur, ...f]);
        return p[p.length - 1];
      });
      return p.slice(0, -1);
    });
  }, []);
  const redo = useCallback(() => {
    setFuture((f) => {
      if (!f.length) return f;
      setDoc((cur) => {
        setPast((p) => [...p, cur]);
        return f[0];
      });
      return f.slice(1);
    });
  }, []);
  return { doc, commit, update, undo, redo, canUndo: past.length > 0, canRedo: future.length > 0 };
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function App() {
  const kernel = useRef<KernelClient | null>(null);
  const [kernelState, setKernelState] = useState<KernelState>("loading");
  const [kernelError, setKernelError] = useState("");
  const { doc, commit, update, undo, redo, canUndo, canRedo } = useDocument(demoDocument);
  const [editingSketchId, setEditingSketchId] = useState<string | null>(null);
  const [solverState, setSolverState] = useState<KernelState>("loading");
  const [newSketchPlane, setNewSketchPlane] = useState<PlaneName>("XY");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mesh, setMesh] = useState<MeshData | null>(null);
  const [sketchPreviews, setSketchPreviews] = useState<SketchPreview[]>([]);
  const [status, setStatus] = useState<Map<string, FeatureStatus>>(new Map());
  const [evalMs, setEvalMs] = useState<number | null>(null);
  const [hoverFace, setHoverFace] = useState<number | null>(null);

  useEffect(() => {
    const k = new KernelClient();
    kernel.current = k;
    k.onReady = () => setKernelState("ready");
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

  useEffect(() => {
    kernel.current?.evaluate(doc);
  }, [doc]);

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
  const errors = [...status.values()].filter((s) => !s.ok);

  const add = (f: Feature) => {
    commit({ features: [...doc.features, f] });
    setSelectedId(f.id);
  };

  const editingSketch = doc.features.find((f): f is SketchFeature => f.id === editingSketchId && f.type === "sketch") ?? null;
  const startSketchEdit = (id: string) => {
    if (solverState !== "ready") return;
    setSelectedId(id);
    setEditingSketchId(id);
  };
  const newSketch = () => {
    const f = makeSketch(doc, newSketchPlane);
    add(f);
    startSketchEdit(f.id);
  };

  const exportAs = async (format: "step" | "stl") => {
    try {
      const blob = await kernel.current!.export(doc, format);
      download(blob, `model.${format}`);
    } catch (e) {
      alert(`Export failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">OpenShape</strong>
        <div className="group">
          <button disabled={solverState !== "ready" || !!editingSketch} onClick={newSketch} title="New sketch on the chosen plane">
            ✎ Sketch
          </button>
          <select value={newSketchPlane} onChange={(e) => setNewSketchPlane(e.target.value as PlaneName)} disabled={!!editingSketch} title="Sketch plane">
            <option value="XY">XY (top)</option>
            <option value="XZ">XZ (front)</option>
            <option value="YZ">YZ (right)</option>
          </select>
        </div>
        <div className={`group${editingSketch ? " hidden" : ""}`}>
          <button disabled={!baseSketch} onClick={() => add(makeExtrude(doc, baseSketch!.id, hasBody(doc) ? "join" : "new"))}>
            ⬆ Extrude
          </button>
          <button disabled={!baseSketch} onClick={() => add(makeRevolve(doc, baseSketch!.id, hasBody(doc) ? "join" : "new"))}>
            ↻ Revolve
          </button>
          <button disabled={!hasBody(doc)} onClick={() => add(makeEdgeTreatment(doc, "fillet"))}>◜ Fillet</button>
          <button disabled={!hasBody(doc)} onClick={() => add(makeEdgeTreatment(doc, "chamfer"))}>◸ Chamfer</button>
        </div>
        <div className="group">
          <button disabled={!canUndo} onClick={undo} title="⌘Z">↶</button>
          <button disabled={!canRedo} onClick={redo} title="⇧⌘Z">↷</button>
        </div>
        <div className="group right">
          <button disabled={kernelState !== "ready" || !mesh} onClick={() => exportAs("step")}>STEP</button>
          <button disabled={kernelState !== "ready" || !mesh} onClick={() => exportAs("stl")}>STL</button>
        </div>
      </header>

      <HistoryPanel
        features={doc.features}
        status={status}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onEdit={(id) => doc.features.find((f) => f.id === id)?.type === "sketch" && startSketchEdit(id)}
        onToggle={(id) => {
          const f = doc.features.find((x) => x.id === id)!;
          commit(updateFeature(doc, id, { suppressed: !f.suppressed }));
        }}
        onDelete={(id) => {
          commit(removeFeature(doc, id));
          if (selectedId === id) setSelectedId(null);
        }}
      />

      <main className="stage">
        <Viewport
          mesh={mesh}
          sketches={sketchPreviews}
          selectedSketchId={selected?.type === "sketch" ? selected.id : null}
          onHoverFace={setHoverFace}
        />
        {editingSketch && (
          <SketchEditor
            key={editingSketch.id}
            feature={editingSketch}
            onCommit={(sketch) => update((cur) => updateFeature(cur, editingSketch.id, { sketch }))}
            onExit={() => setEditingSketchId(null)}
          />
        )}
        {kernelState === "loading" && <div className="overlay">Loading OpenCascade kernel…</div>}
        {kernelState === "error" && <div className="overlay error-msg">Kernel unavailable: {kernelError}</div>}
      </main>

      <PropertiesPanel
        feature={selected}
        sketches={sketches}
        status={selected ? status.get(selected.id) : undefined}
        onChange={(patch) => selected && commit(updateFeature(doc, selected.id, patch))}
        onEditSketch={startSketchEdit}
        canEditSketch={solverState === "ready" && !editingSketch}
      />

      <footer className="statusbar">
        <span>Kernel: {kernelState}</span>
        <span>Solver: {solverState}</span>
        {evalMs != null && <span>Rebuild: {evalMs.toFixed(0)} ms</span>}
        <span>Face: {hoverFace == null ? "—" : `#${hoverFace + 1}`}</span>
        {errors.length > 0 && <span className="error-msg">{errors.length} errors in history</span>}
      </footer>
    </div>
  );
}
