// Owner-input bounds shared by the owner routes.

/** $1,000 per UTC day: far above any credit allowance, low enough to catch a typo. */
export const MAX_DAILY_CAP_USD_MICRO = 1_000_000_000n;

/** 10 USDC per unit: well above any sensible per-minute price, low enough to catch a typo. */
export const MAX_PRICE_ATOMIC = 10_000_000n;
