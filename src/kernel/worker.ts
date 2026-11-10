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

ctx.onmessage = async (ev: MessageEvent<KernelRequest>) => {
  await ready;
  const req = ev.data;

  if (req.kind === "evaluate") {
    const t0 = performance.now();
    const { body, sketches, status } = await evaluate(req.doc, { stopBefore: req.stopBefore });
    let mesh = null;
    if (body) {
      try {
        mesh = meshBody(body);
      } catch (e) {
        status.push({ id: "__mesh__", ok: false, error: `Meshing failed: ${String(e)}` });
      }
      body.shape.delete();
    }
    const transfer: Transferable[] = [];
    if (mesh) transfer.push(mesh.vertices.buffer, mesh.normals.buffer, mesh.triangles.buffer, mesh.edges.buffer);
    post({ kind: "evaluated", seq: req.seq, mesh, sketches, status, ms: performance.now() - t0 }, transfer);
    return;
  }

  if (req.kind === "export") {
    const { body } = await evaluate(req.doc);
    if (!body) {
      post({ kind: "exported", seq: req.seq, error: "No body to export" });
      return;
    }
    try {
      if (req.format === "step") {
        post({ kind: "exported", seq: req.seq, blob: body.shape.blobSTEP() });
      } else {
        // Export-quality tessellation: much finer than the viewport mesh.
        const m = body.shape.mesh({ tolerance: 0.01, angularTolerance: 5 });
        const vertices = new Float32Array(m.vertices), triangles = new Uint32Array(m.triangles);
        post({ kind: "exported", seq: req.seq, mesh: { vertices, triangles } }, [vertices.buffer, triangles.buffer]);
      }
    } catch (e) {
      post({ kind: "exported", seq: req.seq, error: String(e) });
    } finally {
      body.shape.delete();
    }
  }
};
