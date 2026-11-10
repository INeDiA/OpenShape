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
    const { body, sketches, status } = evaluate(req.doc);
    let mesh = null;
    if (body) {
      try {
        mesh = meshBody(body);
      } catch (e) {
        status.push({ id: "__mesh__", ok: false, error: `Meshing failed: ${String(e)}` });
      }
      body.delete();
    }
    const transfer: Transferable[] = [];
    if (mesh) transfer.push(mesh.vertices.buffer, mesh.normals.buffer, mesh.triangles.buffer, mesh.edges.buffer);
    post({ kind: "evaluated", seq: req.seq, mesh, sketches, status, ms: performance.now() - t0 }, transfer);
    return;
  }

  if (req.kind === "export") {
    const { body } = evaluate(req.doc);
    if (!body) {
      post({ kind: "exported", seq: req.seq, blob: null, error: "No body to export" });
      return;
    }
    try {
      const blob = req.format === "step" ? body.blobSTEP() : body.blobSTL({ binary: true });
      post({ kind: "exported", seq: req.seq, blob });
    } catch (e) {
      post({ kind: "exported", seq: req.seq, blob: null, error: String(e) });
    } finally {
      body.delete();
    }
  }
};
