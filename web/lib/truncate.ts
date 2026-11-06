export function truncateMiddle(value: string, headLength = 6, tailLength = 4): string {
  if (!Number.isInteger(headLength) || headLength < 1) {
    throw new RangeError("headLength must be a positive integer");
  }
  if (!Number.isInteger(tailLength) || tailLength < 1) {
    throw new RangeError("tailLength must be a positive integer");
  }

  if (value.length <= headLength + tailLength + 1) return value;
  return `${value.slice(0, headLength)}…${value.slice(-tailLength)}`;
}
