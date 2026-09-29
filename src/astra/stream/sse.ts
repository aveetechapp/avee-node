import { AstraConnectionError, AstraError, AstraTimeoutError, AstraValidationError } from "../errors.js";
import { httpError } from "../http.js";
import { decodeUpdateEnvelope } from "../models.js";
import type { StreamSink, StreamTransport } from "./transport.js";

export class SseParser {
  private carry = "";
  private data: string[] = [];
  private size = 0;
  private readonly maxBytes: number;
  private readonly onData: (data: string) => void;

  constructor(maxBytes: number, onData: (data: string) => void) {
    this.maxBytes = maxBytes;
    this.onData = onData;
  }

  push(text: string): void {
    const buf = this.carry + text;
    let start = 0;
    for (let nl = buf.indexOf("\n", start); nl >= 0; nl = buf.indexOf("\n", start)) {
      const end = nl > start && buf.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
      this.line(buf.slice(start, end));
      start = nl + 1;
    }
    this.carry = buf.slice(start);
    if (this.carry.length > this.maxBytes) throw new AstraConnectionError(`SSE line exceeds ${this.maxBytes} bytes`);
  }

  private line(line: string): void {
    if (line === "") {
      if (this.data.length > 0) {
        const payload = this.data.join("\n");
        this.data = [];
        this.size = 0;
        this.onData(payload);
      }
      return;
    }
    if (line.charCodeAt(0) === 58) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== "data") return;
    const value = colon < 0 ? "" : line.slice(line.charCodeAt(colon + 1) === 32 ? colon + 2 : colon + 1);
    this.size += value.length;
    if (this.size > this.maxBytes) throw new AstraConnectionError(`SSE event exceeds ${this.maxBytes} bytes`);
    this.data.push(value);
  }
}

export interface SseConfig {
  url: string;
  fetch: typeof fetch;
  headers: Readonly<Record<string, string>>;
  idleTimeoutMs: number;
  maxMessageBytes: number;
}

export class SseTransport implements StreamTransport {
  private readonly config: SseConfig;

  constructor(config: SseConfig) {
    this.config = config;
  }

  async run(signal: AbortSignal, sink: StreamSink): Promise<void> {
    const { url, idleTimeoutMs } = this.config;
    const controller = new AbortController();
    let idle = false;
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const fire = () => {
      idle = true;
      controller.abort();
    };
    let timer = setTimeout(fire, idleTimeoutMs);
    try {
      const res = await this.config.fetch(url, {
        headers: { accept: "text/event-stream", ...this.config.headers },
        signal: controller.signal,
      });
      if (!res.ok) throw await httpError(res, url);
      if (!res.body) throw new AstraConnectionError(`SSE response from ${url} has no body`);
      sink.opened();
      const parser = new SseParser(this.config.maxMessageBytes, (data) => dispatch(data, sink));
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        clearTimeout(timer);
        timer = setTimeout(fire, idleTimeoutMs);
        parser.push(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      if (signal.aborted) return;
      if (idle) throw new AstraTimeoutError(`SSE stream idle for ${idleTimeoutMs} ms`);
      if (err instanceof AstraError) throw err;
      throw new AstraConnectionError(`SSE stream failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }
}

function dispatch(data: string, sink: StreamSink): void {
  let body: unknown;
  try {
    body = JSON.parse(data);
  } catch {
    sink.warn(new AstraValidationError("SSE event is not JSON"));
    return;
  }
  let updates;
  try {
    updates = decodeUpdateEnvelope(body, "event");
  } catch (err) {
    sink.warn(err instanceof AstraError ? err : new AstraValidationError(String(err)));
    return;
  }
  for (const u of updates) sink.update(u);
}
