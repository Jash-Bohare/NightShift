import type { BuyerEvent } from "@nightshift/shared/buyerEvents";
import type { BuyerBudget } from "./api";

export type WireState =
  "waiting" | "found" | "verified" | "chosen" | "refused" | "paying" | "paid" | "done";

export interface ConsoleState {
  events: BuyerEvent[];
  wire: Record<string, WireState>;
  phase: "idle" | "running" | "resuming" | "complete" | "error" | "disconnected";
  error: string | null;
  runId: string | null;
}

export const initialConsoleState: ConsoleState = {
  events: [],
  wire: {},
  phase: "idle",
  error: null,
  runId: null,
};

export type ConsoleAction =
  | { type: "start"; runId: string }
  | { type: "set-run-id"; runId: string }
  | { type: "resume" }
  | { type: "event"; event: BuyerEvent }
  | { type: "complete"; success: boolean; message?: string }
  | { type: "connection-error"; message: string }
  | { type: "reset" };

export function reduceConsole(state: ConsoleState, action: ConsoleAction): ConsoleState {
  switch (action.type) {
    case "start":
      return { ...initialConsoleState, phase: "running", runId: action.runId };
    case "set-run-id":
      return { ...state, runId: action.runId };
    case "resume":
      return { ...state, phase: "resuming", error: null };
    case "event": {
      const event = action.event;
      if (state.events.some((existing) => JSON.stringify(existing) === JSON.stringify(event))) {
        return state;
      }
      const wire = { ...state.wire };
      if (event.kind === "discover") {
        for (const candidate of event.candidates) wire[candidate.label] = "found";
      } else if (event.kind === "verify") {
        wire[event.label] = event.ok ? "verified" : "refused";
      } else if (event.kind === "decide") {
        wire[event.chosen.label] = "chosen";
      } else if (event.kind === "quote") {
        wire[event.label] = "paying";
      } else if (event.kind === "paid") {
        wire[event.label] = "paid";
      } else if (event.kind === "result") {
        wire[event.label] = "done";
      } else if (event.kind === "refused" || event.kind === "payment_failed") {
        wire[event.label] = "refused";
      }
      return {
        ...state,
        events: [...state.events, event],
        wire,
        phase: event.kind === "error" ? "error" : state.phase,
        error: event.kind === "error" ? event.message : state.error,
      };
    }
    case "complete":
      return {
        ...state,
        phase: action.success ? "complete" : "error",
        error: action.success ? null : (action.message ?? "The buyer run did not complete."),
      };
    case "connection-error":
      return { ...state, phase: "disconnected", error: action.message };
    case "reset":
      return initialConsoleState;
  }
}

export function parseBuyerEvent(kind: string, data: string): BuyerEvent | null {
  if (kind === "complete") return null;
  const parsed: unknown = JSON.parse(data);
  if (!isBuyerEvent(kind, parsed))
    throw new Error(`Malformed ${kind} event from the buyer stream.`);
  return parsed;
}

export function parseSseFrame(
  frame: string,
): { event: string; data: string; comment?: string } | null {
  let event = "message";
  let comment: string | undefined;
  const data: string[] = [];
  for (const line of frame.replace(/\r\n/g, "\n").split("\n")) {
    if (!line) continue;
    if (line.startsWith(":")) {
      if (!comment) comment = line.slice(1).trim();
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  return data.length || comment ? { event, data: data.join("\n"), comment } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Integer string in atomic units: the only shape the page may pass to BigInt. */
function isAtomic(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,30}$/.test(value);
}

function isBuyerEvent(kind: string, value: unknown): value is BuyerEvent {
  if (!isRecord(value) || value.kind !== kind || typeof value.timestamp !== "string") return false;
  switch (kind) {
    case "plan":
      return (
        isRecord(value.task) &&
        typeof value.task.skill === "string" &&
        typeof value.task.units === "number" &&
        isRecord(value.rules)
      );
    case "discover":
      return (
        Array.isArray(value.candidates) &&
        value.candidates.every(
          (candidate) =>
            isRecord(candidate) &&
            typeof candidate.label === "string" &&
            typeof candidate.ensName === "string" &&
            typeof candidate.skill === "string" &&
            isAtomic(candidate.priceAtomic),
        )
      );
    case "verify":
      return (
        typeof value.label === "string" &&
        typeof value.ensName === "string" &&
        typeof value.ok === "boolean"
      );
    case "decide":
      return (
        isRecord(value.chosen) &&
        typeof value.chosen.label === "string" &&
        typeof value.chosen.ensName === "string" &&
        typeof value.rationale === "string"
      );
    case "quote":
      return (
        typeof value.label === "string" &&
        isAtomic(value.amount) &&
        typeof value.asset === "string" &&
        typeof value.units === "number"
      );
    case "refused":
      return (
        typeof value.label === "string" &&
        typeof value.reason === "string" &&
        typeof value.status === "number"
      );
    case "payment_failed":
      return typeof value.label === "string" && typeof value.error === "string";
    case "paid":
      return (
        typeof value.label === "string" &&
        isAtomic(value.amount) &&
        typeof value.txId === "string" &&
        typeof value.hashscanUrl === "string"
      );
    case "result":
      return typeof value.label === "string" && typeof value.text === "string";
    case "error":
      return typeof value.message === "string";
    default:
      return false;
  }
}

/**
 * GET /buyer-console/budget, validated once at the boundary so every amount the page renders
 * (and passes to BigInt) is an integer string. Throws a readable error instead of crashing.
 */
export function parseBuyerBudget(value: unknown): BuyerBudget {
  const bad = () => new Error("The buyer budget response is malformed.");
  if (!isRecord(value) || !isRecord(value.rules) || !isRecord(value.state)) throw bad();
  const { rules, state, wallet } = value;
  for (const key of ["maxPerJobAtomic", "dailyBudgetAtomic", "humanApprovalAboveAtomic"])
    if (!isAtomic(rules[key])) throw bad();
  if (!isAtomic(state.dailySpentAtomic) || !isAtomic(state.totalSpentAtomic)) throw bad();
  if (
    typeof rules.minSuccess !== "number" ||
    !Array.isArray(rules.allowParentNames) ||
    !rules.allowParentNames.every((n) => typeof n === "string")
  )
    throw bad();
  if (wallet !== undefined && wallet !== null) {
    if (
      !isRecord(wallet) ||
      typeof wallet.accountId !== "string" ||
      (wallet.usdcAtomic !== null && !isAtomic(wallet.usdcAtomic)) ||
      (wallet.error !== undefined && typeof wallet.error !== "string")
    )
      throw bad();
  }
  return value as unknown as BuyerBudget;
}

export interface CompleteEvent {
  success: boolean;
  error?: string | null;
}

export type FrameOutcome =
  | { kind: "run-id"; runId: string }
  | { kind: "event"; event: BuyerEvent }
  | { kind: "complete"; result: CompleteEvent };

/**
 * One SSE frame from POST /buyer-console/run → what the page should do with it.
 * The server opens with a `: run-<id>` comment and sends `: ping` heartbeats every 15 s; comment
 * frames carry no data and must never reach the JSON event parser (doing so aborted the stream on
 * its first frame, so a live run never rendered). Malformed buyer events still throw.
 */
export function interpretSseFrame(frame: string): FrameOutcome | null {
  const parsed = parseSseFrame(frame);
  if (!parsed) return null;
  if (!parsed.data) {
    return parsed.comment && /^run-\d+$/.test(parsed.comment)
      ? { kind: "run-id", runId: parsed.comment }
      : null;
  }
  if (parsed.event === "complete") {
    const result: unknown = JSON.parse(parsed.data);
    if (!isRecord(result) || typeof result.success !== "boolean")
      throw new Error("Malformed complete event from buyer stream.");
    return {
      kind: "complete",
      result: {
        success: result.success,
        error: typeof result.error === "string" ? result.error : null,
      },
    };
  }
  const event = parseBuyerEvent(parsed.event, parsed.data);
  return event ? { kind: "event", event } : null;
}
