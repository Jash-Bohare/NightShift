const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

export function secondsUntilUtcMidnight(now: number): number {
  if (!Number.isFinite(now)) {
    throw new RangeError("now must be a finite timestamp");
  }

  const endOfShift = (Math.floor(now / DAY_IN_MILLISECONDS) + 1) * DAY_IN_MILLISECONDS;
  return Math.max(0, Math.floor((endOfShift - now) / 1000));
}

export function formatCountdown(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError("seconds must be a finite, non-negative number");
  }

  const remaining = Math.floor(seconds);
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const secs = remaining % 60;

  return [hours, minutes, secs].map((part) => String(part).padStart(2, "0")).join(":");
}

export function formatCountdownToUtcMidnight(now: number): string {
  return formatCountdown(secondsUntilUtcMidnight(now));
}

export function formatElapsed(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new RangeError("milliseconds must be a finite, non-negative number");
  }
  const total = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
