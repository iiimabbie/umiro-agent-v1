import type { Message } from "./types.js";

export type DiscordQueueMode = "followup" | "steer";

export interface PendingRunInput {
  message: Message;
  images?: string[];
  files?: Array<{ url: string; name: string; contentType: string; size?: number }>;
  /** Discord snowflake or another monotonically sortable transport id. */
  order: string;
}

export interface ActiveRunSnapshot {
  sessionId: string;
  userId?: string;
  startedAt: number;
  stopRequested: boolean;
  pendingInputs: number;
}

export class RunStoppedError extends Error {
  constructor() {
    super("active run stopped");
    this.name = "RunStoppedError";
  }
}

function compareOrder(a: PendingRunInput, b: PendingRunInput): number {
  try {
    const left = BigInt(a.order);
    const right = BigInt(b.order);
    return left < right ? -1 : left > right ? 1 : 0;
  } catch {
    return a.order.localeCompare(b.order);
  }
}

export class ActiveRunHandle {
  readonly controller = new AbortController();
  readonly startedAt = Date.now();
  private pending: PendingRunInput[] = [];
  private stopRequested = false;
  private acceptingSteer = true;

  constructor(readonly sessionId: string, readonly userId?: string) {}

  requestStop(): boolean {
    if (this.stopRequested) return false;
    this.stopRequested = true;
    this.controller.abort(new RunStoppedError());
    return true;
  }

  isStopRequested(): boolean {
    return this.stopRequested;
  }

  enqueue(input: PendingRunInput): boolean {
    if (!this.acceptingSteer || this.stopRequested) return false;
    this.pending.push(input);
    this.pending.sort(compareOrder);
    return true;
  }

  drainPending(): PendingRunInput[] {
    const drained = this.pending;
    this.pending = [];
    return drained;
  }

  /**
   * Atomically drain pending input or stop accepting steer before final delivery.
   * Because JavaScript runs this synchronously, a trigger arriving afterwards will
   * fall back to followup instead of being accepted into a run that is about to end.
   */
  drainPendingOrSeal(): PendingRunInput[] {
    if (this.pending.length > 0) return this.drainPending();
    this.acceptingSteer = false;
    return [];
  }

  snapshot(): ActiveRunSnapshot {
    return {
      sessionId: this.sessionId,
      userId: this.userId,
      startedAt: this.startedAt,
      stopRequested: this.stopRequested,
      pendingInputs: this.pending.length,
    };
  }
}

export class ActiveRunRegistry {
  private readonly runs = new Map<string, ActiveRunHandle>();

  start(sessionId: string, userId?: string): ActiveRunHandle {
    if (this.runs.has(sessionId)) throw new Error(`session already has an active run: ${sessionId}`);
    const handle = new ActiveRunHandle(sessionId, userId);
    this.runs.set(sessionId, handle);
    return handle;
  }

  finish(handle: ActiveRunHandle): void {
    if (this.runs.get(handle.sessionId) === handle) this.runs.delete(handle.sessionId);
  }

  get(sessionId: string): ActiveRunHandle | undefined {
    return this.runs.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.runs.has(sessionId);
  }

  requestStop(sessionId: string, requesterId?: string, ownerId?: string): "stopping" | "already-stopping" | "forbidden" | "idle" {
    const run = this.runs.get(sessionId);
    if (!run) return "idle";
    if (requesterId && requesterId !== ownerId && requesterId !== run.userId) return "forbidden";
    return run.requestStop() ? "stopping" : "already-stopping";
  }

  steer(sessionId: string, requesterId: string | undefined, input: PendingRunInput): boolean {
    const run = this.runs.get(sessionId);
    // A run keeps the verified permissions of its original request. Never splice a
    // different Discord author's text into that authorization context.
    if (!run || run.userId !== requesterId) return false;
    return run.enqueue(input);
  }

  snapshot(sessionId: string): ActiveRunSnapshot | null {
    return this.runs.get(sessionId)?.snapshot() ?? null;
  }
}

export const activeRuns = new ActiveRunRegistry();
