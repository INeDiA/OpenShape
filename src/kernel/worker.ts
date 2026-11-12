/// <reference lib="webworker" />
import wasmUrl from "replicad-opencascadejs/wasm?url";
import multiWasmUrl from "replicad-opencascadejs/multi/wasm?url";
import { setOC } from "replicad";
import { setBooleanParallel } from "./booleans";
import type { KernelRequest, KernelResponse } from "../model/types";
import { evaluate, meshBody } from "./evaluate";
import { measureSelection } from "./measure";
import { projectView } from "./projection";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: KernelResponse, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);

// With cross-origin isolation (SharedArrayBuffer available) load the multi-threaded
// OCCT build and run Booleans in parallel; otherwise the single-threaded one.
const threaded = ctx.crossOriginIsolated === true;
const ready = (async () => {
  const mod = threaded ? await import("replicad-opencascadejs/multi") : await import("replicad-opencascadejs");
  const oc = await mod.default({ locateFile: () => (threaded ? multiWasmUrl : wasmUrl) });
  setOC(oc);
  setBooleanParallel(threaded);
  post({ kind: "ready", threads: threaded ? navigator.hardwareConcurrency : 1 });
})().catch((e) => {
  post({ kind: "init-error", error: String(e) });
  throw e;
});

async function handleEvaluate(req: Extract<KernelRequest, { kind: "evaluate" }>) {
  const t0 = performance.now();
  try {
    const { body, bodies, faceBody, sketches, status, ownsBody } = await evaluate(req.doc, { stopBefore: req.stopBefore });
    // Read everything we need before freeing kernel memory.
    const bodyInfo = bodies.map((b) => ({ id: b.id, faces: b.shape.shape.faces.length }));
    let mesh = null;
    if (body) {
      try {
        mesh = meshBody(body, faceBody, req.preview);
      } catch (e) {
        status.push({ id: "__mesh__", ok: false, error: `Meshing failed: ${String(e)}` });
      }
      // Bodies are cached for incremental evaluation; only a compound made for this result is ours to free.
      if (ownsBody) body.shape.delete();
    }
    const transfer: Transferable[] = [];
    if (mesh) transfer.push(mesh.vertices.buffer, mesh.normals.buffer, mesh.triangles.buffer, mesh.edges.buffer);
    post({ kind: "evaluated", seq: req.seq, mesh, bodies: bodyInfo, sketches, status, ms: performance.now() - t0 }, transfer);
  } catch (e) {
    // Always answer: the client keeps at most one evaluation in flight.
    console.error(e);
    post({ kind: "evaluated", seq: req.seq, mesh: null, bodies: [], sketches: [], status: [{ id: "__kernel__", ok: false, error: `Kernel error: ${String(e)}` }], ms: performance.now() - t0 });
  }
}

async function handleExport(req: Extract<KernelRequest, { kind: "export" }>) {
  try {
    const { body, ownsBody } = await evaluate(req.doc);
    if (!body) return post({ kind: "exported", seq: req.seq, error: "No body to export" });
    try {
      if (req.format === "step") {
        post({ kind: "exported", seq: req.seq, blob: body.shape.blobSTEP() });
      } else {
        // Export-quality tessellation: much finer than the viewport mesh.
        const m = body.shape.mesh({ tolerance: 0.01, angularTolerance: 5 });
        const vertices = new Float32Array(m.vertices), triangles = new Uint32Array(m.triangles);
        post({ kind: "exported", seq: req.seq, mesh: { vertices, triangles } }, [vertices.buffer, triangles.buffer]);
      }
    } finally {
      if (ownsBody) body.shape.delete();
    }
  } catch (e) {
    post({ kind: "exported", seq: req.seq, error: String(e) });
  }
}

async function handleMeasure(req: Extract<KernelRequest, { kind: "measure" }>) {
  try {
    const result = await evaluate(req.doc);
    try {
      post({ kind: "measured", seq: req.seq, measurement: measureSelection(result, req.selection) });
    } finally {
      if (result.ownsBody) result.body?.shape.delete();
    }
  } catch (e) {
    post({ kind: "measured", seq: req.seq, error: String(e) });
  }
}

async function handleProject(req: Extract<KernelRequest, { kind: "project" }>) {
  try {
    const { body, ownsBody } = await evaluate(req.doc);
    if (!body) return post({ kind: "projected", seq: req.seq, views: [] });
    try {
      const views = req.dirs.map((d) => projectView(body.shape, d));
      post({ kind: "projected", seq: req.seq, views }, views.flatMap((v) => [v.visible.buffer, v.hidden.buffer]));
    } finally {
      if (ownsBody) body.shape.delete();
    }
  } catch (e) {
    post({ kind: "projected", seq: req.seq, error: String(e) });
  }
}

// Requests run one at a time: evaluation is async (imports) and must not interleave.
let queue: Promise<void> = Promise.resolve();
ctx.onmessage = (ev: MessageEvent<KernelRequest>) => {
  const req = ev.data;
  queue = queue.then(async () => {
    await ready;
    if (req.kind === "evaluate") await handleEvaluate(req);
    else if (req.kind === "export") await handleExport(req);
    else if (req.kind === "measure") await handleMeasure(req);
    else if (req.kind === "project") await handleProject(req);
  });
};
