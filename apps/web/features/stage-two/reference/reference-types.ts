export type ReferenceRange = { start: number; end: number };
export type ReferenceTelemetry = { time: number; state: number; rate: number; wallTime: number; epochTime?: number };
export type ReferenceClip = {
  blob: Blob;
  /** One continuous capture; never interchangeable with another recording of the same sentence. */
  captureId?: string;
  sentenceId: string;
  rangeStart: number;
  rangeEnd: number;
  /** Browser telemetry estimates relative to the encoded capture, not acoustic alignment. */
  startOffsetMs: number;
  endOffsetMs: number;
};
