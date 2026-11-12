import type { Document, KernelRequest, KernelResponse, Measurement, MeasureSelection } from "../model/types";

type Evaluated = Extract<KernelResponse, { kind: "evaluated" }>;

/**
 * Thin wrapper over the kernel worker. Evaluations are coalesced: at most one
 * is in flight; while it runs only the newest request is kept and sent next.
 * That keeps live previews (dragging a handle) responsive without a backlog.
 */
export class KernelClient {
  private worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  private seq = 0;
  private inFlight = false;
  private queued: { doc: Document; stopBefore?: string; preview?: boolean } | null = null;
  private pendingExports = new Map<number, (r: Extract<KernelResponse, { kind: "exported" }>) => void>();
  private pendingMeasures = new Map<number, (r: Extract<KernelResponse, { kind: "measured" }>) => void>();

  onReady: (threads: number) => void = () => {};
  onInitError: (e: string) => void = () => {};
  onEvaluated: (r: Evaluated) => void = () => {};
  /** True while an evaluation is running or waiting to run. */
  onBusy: (busy: boolean) => void = () => {};

  constructor() {
    this.worker.onmessage = (ev: MessageEvent<KernelResponse>) => {
      const msg = ev.data;
      switch (msg.kind) {
        case "ready":
          this.onReady(msg.threads ?? 1);
          break;
        case "init-error":
          this.onInitError(msg.error);
          break;
        case "evaluated":
          this.inFlight = false;
          // Show every completed result (it's the newest one finished: only one runs at a
          // time), then start the newest queued request. Dropping results while a newer
          // one waits would hide all intermediate frames of a drag.
          this.onEvaluated(msg);
          if (this.queued) {
            const q = this.queued;
            this.queued = null;
            this.dispatch(q.doc, q.stopBefore, q.preview);
          } else this.onBusy(false);
          break;
        case "measured":
          this.pendingMeasures.get(msg.seq)?.(msg);
          this.pendingMeasures.delete(msg.seq);
          break;
        case "exported":
          this.pendingExports.get(msg.seq)?.(msg);
          this.pendingExports.delete(msg.seq);
          break;
      }
    };
  }

  /** `preview`: coarse, fast result while dragging; a final full evaluation follows. */
  evaluate(doc: Document, stopBefore?: string, preview = false) {
    if (this.inFlight) {
      this.queued = { doc, stopBefore, preview };
      return;
    }
    this.dispatch(doc, stopBefore, preview);
  }

  private dispatch(doc: Document, stopBefore?: string, preview = false) {
    const seq = ++this.seq;
    this.inFlight = true;
    this.onBusy(true);
    this.send({ kind: "evaluate", seq, doc, stopBefore, preview });
  }

  exportSTEP(doc: Document): Promise<Blob> {
    return this.request(doc, "step").then((r) => r.blob!);
  }

  /** Fine tessellation for mesh formats (STL, 3MF, ...). */
  exportMesh(doc: Document): Promise<{ vertices: Float32Array; triangles: Uint32Array }> {
    return this.request(doc, "mesh").then((r) => r.mesh!);
  }

  /** Measures faces/edges/a body of the final model of `doc`. */
  measure(doc: Document, selection: MeasureSelection): Promise<Measurement> {
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pendingMeasures.set(seq, (r) => (r.error || !r.measurement ? reject(new Error(r.error ?? "No result")) : resolve(r.measurement)));
      this.send({ kind: "measure", seq, doc, selection });
    });
  }

  private request(doc: Document, format: "step" | "mesh") {
    const seq = ++this.seq;
    return new Promise<Extract<KernelResponse, { kind: "exported" }>>((resolve, reject) => {
      this.pendingExports.set(seq, (r) => (r.error ? reject(new Error(r.error)) : resolve(r)));
      this.send({ kind: "export", seq, doc, format });
    });
  }

  private send(req: KernelRequest) {
    this.worker.postMessage(req);
  }
}
