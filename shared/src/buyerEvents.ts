// Buyer events and spending rule definitions shared by buyer/, server/ and web/.

/** `nightshift.reputation` text record, written only by the registrar. `success` is a rate in [0, 1]. */
export interface AgentReputation {
  jobs: number;
  success: number;
  p50_ms: number;
  updated?: string;
}

export interface BuyerRules {
  maxPerJobAtomic: string; // e.g. "100000" ($0.10)
  dailyBudgetAtomic: string; // e.g. "1000000" ($1.00)
  allowedAssets: string[]; // ["0.0.429274"]
  allowedNetworks: string[]; // ["hedera:testnet"]
  allowParentNames: string[]; // ["nightshift.eth"]
  minSuccess: number; // 0.9
  humanApprovalAboveAtomic: string; // "500000"
}

export interface BuyerSpendingState {
  date: string; // YYYY-MM-DD (UTC)
  dailySpentAtomic: string;
  totalSpentAtomic: string;
  jobsCompleted: number;
  lastUpdated: string; // ISO-8601
}

export type BuyerEventKind =
  | "plan"
  | "discover"
  | "verify"
  | "decide"
  | "quote"
  | "refused"
  | "payment_failed"
  | "paid"
  | "result"
  | "error";

export interface BuyerPlanEvent {
  kind: "plan";
  task: {
    skill: string;
    file?: string;
    units: number;
  };
  rules: BuyerRules;
  timestamp: string;
}

export interface BuyerDiscoverEvent {
  kind: "discover";
  candidates: Array<{
    label: string;
    ensName: string;
    skill: string;
    priceAtomic: string;
    reputation: AgentReputation | null;
  }>;
  timestamp: string;
}

export interface BuyerVerifyEvent {
  kind: "verify";
  label: string;
  ensName: string;
  ok: boolean;
  reason?: string;
  resolver?: string;
  payTo?: string;
  timestamp: string;
}

export interface BuyerDecideEvent {
  kind: "decide";
  chosen: {
    label: string;
    ensName: string;
    priceAtomic: string;
    payTo: string;
  };
  rationale: string;
  rejected: Array<{
    label: string;
    reason: string;
  }>;
  timestamp: string;
}

export interface BuyerQuoteEvent {
  kind: "quote";
  label: string;
  units: number;
  amount: string;
  asset: string;
  payTo: string;
  timestamp: string;
}

export interface BuyerRefusedEvent {
  kind: "refused";
  label: string;
  status: number;
  reason: string;
  timestamp: string;
}

export interface BuyerPaymentFailedEvent {
  kind: "payment_failed";
  label: string;
  error: string;
  timestamp: string;
}

export interface BuyerPaidEvent {
  kind: "paid";
  label: string;
  txId: string;
  hashscanUrl: string;
  amount: string;
  timestamp: string;
}

export interface BuyerResultEvent {
  kind: "result";
  label: string;
  text: string;
  jobId?: string;
  zgRequestId?: string;
  latencyMs?: number;
  timestamp: string;
}

export interface BuyerErrorEvent {
  kind: "error";
  message: string;
  step?: string;
  timestamp: string;
}

export type BuyerEvent =
  | BuyerPlanEvent
  | BuyerDiscoverEvent
  | BuyerVerifyEvent
  | BuyerDecideEvent
  | BuyerQuoteEvent
  | BuyerRefusedEvent
  | BuyerPaymentFailedEvent
  | BuyerPaidEvent
  | BuyerResultEvent
  | BuyerErrorEvent;

export type BuyerEventHandler = (event: BuyerEvent) => void;
