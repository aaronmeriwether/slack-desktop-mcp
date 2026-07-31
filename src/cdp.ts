import type { Readable, Writable } from "node:stream";

const TIMEOUT_MS = 15_000;

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

// CDP over --remote-debugging-pipe: NUL-delimited JSON on a pair of inherited
// fds, so no TCP port is opened and only this process can drive the browser.
export class PipeCDP {
  private id = 0;
  private buf = Buffer.alloc(0);
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(
    private w: Writable,
    r: Readable,
  ) {
    r.on("data", (chunk: Buffer) => this.onData(chunk));
    // EOF means the browser is gone and no reply is coming; fail now instead of
    // making every in-flight call wait out its timeout.
    for (const ev of ["close", "end", "error"]) r.on(ev, () => this.failAll());
  }

  private failAll(): void {
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("CDP pipe closed"));
    }
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    let idx: number;
    while ((idx = this.buf.indexOf(0)) !== -1) {
      const msg = this.buf.subarray(0, idx).toString("utf8");
      this.buf = this.buf.subarray(idx + 1);
      let obj: any;
      try {
        obj = JSON.parse(msg);
      } catch {
        continue;
      }
      const p = obj.id && this.pending.get(obj.id);
      if (!p) continue;
      clearTimeout(p.timer);
      this.pending.delete(obj.id);
      obj.error ? p.reject(new Error(obj.error.message ?? JSON.stringify(obj.error))) : p.resolve(obj.result);
    }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    if (this.closed) return Promise.reject(new Error(`CDP pipe closed (${method})`));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.w.write(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }) + "\0");
    });
  }
}
