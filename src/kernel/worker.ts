/// <reference lib="webworker" />
import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { setOC } from "replicad";
import type { KernelRequest, KernelResponse } from "../model/types";
import { evaluate, meshBody } from "./evaluate";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: KernelResponse, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);

const ready = opencascade({ locateFile: () => wasmUrl })
  .then((oc) => {
    setOC(oc);
    post({ kind: "ready" });
  })
  .catch((e) => {
    post({ kind: "init-error", error: String(e) });
    throw e;
  });

async function handleEvaluate(req: Extract<KernelRequest, { kind: "evaluate" }>) {
  const t0 = performance.now();
  try {
    const { body, bodies, faceBody, sketches, status } = await evaluate(req.doc, { stopBefore: req.stopBefore });
    // Read everything we need before freeing kernel memory.
    const bodyInfo = bodies.map((b) => ({ id: b.id, faces: b.shape.shape.faces.length }));
    let mesh = null;
    if (body) {
      try {
        mesh = meshBody(body, faceBody);
      } catch (e) {
        status.push({ id: "__mesh__", ok: false, error: `Meshing failed: ${String(e)}` });
      }
      body.shape.delete();
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
    const { body } = await evaluate(req.doc);
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
      body.shape.delete();
    }
  } catch (e) {
    post({ kind: "exported", seq: req.seq, error: String(e) });
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
  });
};
