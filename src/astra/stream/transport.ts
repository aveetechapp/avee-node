import type { AstraError } from "../errors.js";
import type { PriceUpdate } from "../models.js";

export interface StreamSink {
  opened(): void;
  update(update: PriceUpdate): void;
  warn(err: AstraError): void;
  report(err: AstraError): void;
}

export interface StreamTransport {
  run(signal: AbortSignal, sink: StreamSink): Promise<void>;
}
