import type { DecodedEvent } from "./key-event.js";
import type { PasteBurstAssembler } from "./paste-burst.js";
import type { RawDecoder } from "./raw-decoder.js";

export class InputPipeline {
  constructor(
    private readonly decoder: RawDecoder,
    private readonly bursts: PasteBurstAssembler,
    private readonly now: () => number,
  ) {}

  get pendingDeadline(): number | undefined {
    const deadlines = [this.decoder.pendingDeadline, this.bursts.pendingDeadline].filter(
      (deadline): deadline is number => deadline !== undefined,
    );
    return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
  }

  push(chunk: string): readonly DecodedEvent[] {
    return this.bursts.process(this.decoder.push(chunk), this.now());
  }

  flush(): readonly DecodedEvent[] {
    const now = this.now();
    const decoderDeadline = this.decoder.pendingDeadline;
    const decoded =
      decoderDeadline !== undefined && decoderDeadline <= now ? this.decoder.flush() : [];
    return [...this.bursts.process(decoded, now), ...this.bursts.expire(now)];
  }
}
