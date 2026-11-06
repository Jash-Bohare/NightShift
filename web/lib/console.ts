import type { BuyerEvent } from "@nightshift/shared/buyerEvents";

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
            typeof candidate.priceAtomic === "string",
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
        typeof value.amount === "string" &&
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
        typeof value.amount === "string" &&
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
