import type { Document, KernelRequest, KernelResponse } from "../model/types";

type Evaluated = Extract<KernelResponse, { kind: "evaluated" }>;

/**
 * Thin wrapper over the kernel worker. Evaluations are coalesced: only the
 * latest document is rendered, stale responses are dropped.
 */
export class KernelClient {
  private worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  private seq = 0;
  private latestEval = 0;
  private pendingExports = new Map<number, (r: Extract<KernelResponse, { kind: "exported" }>) => void>();

  onReady: () => void = () => {};
  onInitError: (e: string) => void = () => {};
  onEvaluated: (r: Evaluated) => void = () => {};

  constructor() {
    this.worker.onmessage = (ev: MessageEvent<KernelResponse>) => {
      const msg = ev.data;
      switch (msg.kind) {
        case "ready":
          this.onReady();
          break;
        case "init-error":
          this.onInitError(msg.error);
          break;
        case "evaluated":
          if (msg.seq === this.latestEval) this.onEvaluated(msg);
          break;
        case "exported":
          this.pendingExports.get(msg.seq)?.(msg);
          this.pendingExports.delete(msg.seq);
          break;
      }
    };
  }

  evaluate(doc: Document) {
    const seq = ++this.seq;
    this.latestEval = seq;
    this.send({ kind: "evaluate", seq, doc });
  }

  export(doc: Document, format: "step" | "stl"): Promise<Blob> {
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pendingExports.set(seq, (r) => (r.blob ? resolve(r.blob) : reject(new Error(r.error))));
      this.send({ kind: "export", seq, doc, format });
    });
  }

  private send(req: KernelRequest) {
    this.worker.postMessage(req);
  }
}
