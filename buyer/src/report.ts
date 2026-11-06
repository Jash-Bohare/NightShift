import type { SettlementReport } from "./settlement.js";

export type PaymentState = "not-submitted" | "unknown" | "submitted" | "confirmed" | "unverified";

export interface BuyerExecutionReport {
  success: boolean;
  jobCompleted: boolean;
  jobVerified: boolean;
  jobId?: string;
  paymentState: PaymentState;
  paymentConfirmed: boolean;
  settlementVerified: boolean;
  verification?: SettlementReport;
  chosenAgent?: string;
  output?: string;
  zgRequestId?: string;
  txId?: string;
  hashscanUrl?: string;
  error?: string;
}
