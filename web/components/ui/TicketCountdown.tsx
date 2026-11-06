"use client";

import { formatCountdownToUtcMidnight } from "../../lib/time";
import { useClock } from "../../lib/use-clock";

export function TicketCountdown({ compact = false }: { compact?: boolean }) {
  const now = useClock();
  const countdown = now === null ? "– –:– –:– –" : formatCountdownToUtcMidnight(now);

  if (compact) {
    return (
      <span className="chip ticket-countdown__compact">
        <span className="chip__label">payday in</span>
        <span className="tnum" aria-label="Time until midnight UTC">
          {countdown}
        </span>
      </span>
    );
  }

  return (
    <div className="ticket-countdown" aria-label="Shift ends at midnight UTC">
      <div className="ticket-countdown__stub">
        <span>SHIFT ENDS</span>
        <strong className="tnum">00:00 UTC</strong>
      </div>
      <div className="ticket-countdown__time">
        <span className="kick">credits expire in</span>
        <strong className="tnum" aria-live="off">
          {countdown}
        </strong>
      </div>
    </div>
  );
}
