import { PrivyClient } from "@privy-io/node";
import { ApiError } from "./errors.js";
import { env } from "./config.js";

export interface PrivyAccessTokenClaims {
  app_id: string;
  user_id: string;
  issuer?: string;
  expiration?: number;
}

export const PRIVY_ISSUER = "privy.io";

export type PrivyAccessTokenVerifier = (token: string) => Promise<PrivyAccessTokenClaims>;

export function createPrivyAuthenticator(
  verifyAccessToken: PrivyAccessTokenVerifier,
  appId: string,
): (authorization: string | undefined) => Promise<string> {
  return async (authorization) => {
    const bearer = /^Bearer ([^\s]+)$/i.exec(authorization ?? "");
    if (!bearer) throw new ApiError(401, "unauthorized", "valid Privy authentication is required");

    let claims: PrivyAccessTokenClaims;
    try {
      claims = await verifyAccessToken(bearer[1]!);
    } catch (error) {
      if (error instanceof ApiError) throw error; // e.g. 503 when Privy is not configured
      throw new ApiError(401, "unauthorized", "valid Privy authentication is required");
    }

    // The verifier already checks signature, issuer, audience and expiry; these checks are
    // defence in depth against a misconfigured verifier.
    if (
      !appId ||
      claims.app_id !== appId ||
      !/^did:privy:[A-Za-z0-9]+$/.test(claims.user_id ?? "") ||
      (claims.issuer !== undefined && claims.issuer !== PRIVY_ISSUER) ||
      (claims.expiration !== undefined && claims.expiration * 1000 <= Date.now())
    )
      throw new ApiError(401, "unauthorized", "valid Privy authentication is required");
    return claims.user_id;
  };
}

export function createBuyerConsoleAuthorizer(
  verifyAccessToken: PrivyAccessTokenVerifier,
  appId: string,
  allowedUserIds: ReadonlySet<string>,
): (authorization: string | undefined) => Promise<string> {
  const authenticate = createPrivyAuthenticator(verifyAccessToken, appId);
  return async (authorization) => {
    const userId = await authenticate(authorization);
    if (!allowedUserIds.has(userId))
      throw new ApiError(
        403,
        "forbidden",
        "this account is not permitted to use the buyer console",
      );
    return userId;
  };
}

const allowedUserIds = new Set(
  (env.BUYER_CONSOLE_ALLOWED_PRIVY_USER_IDS ?? "")
    .split(",")
    .map((userId) => userId.trim())
    .filter(Boolean),
);

/**
 * Real Privy verifier (ES256 signature, issuer "privy.io", audience = app id, expiry). With a
 * pinned SPKI key the verification is local; otherwise the Privy app JWKS is fetched.
 */
export function createPrivyVerifier(options: {
  appId: string;
  appSecret: string;
  jwtVerificationKey?: string;
}): PrivyAccessTokenVerifier {
  const privy = new PrivyClient({
    appId: options.appId,
    appSecret: options.appSecret,
    ...(options.jwtVerificationKey ? { jwtVerificationKey: options.jwtVerificationKey } : {}),
  });
  return async (token) => privy.utils().auth().verifyAccessToken(token);
}

let verifier: PrivyAccessTokenVerifier | undefined;

const verifyAccessToken: PrivyAccessTokenVerifier = async (token) => {
  if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET)
    throw new ApiError(503, "feature_disabled", "Privy authorization is not configured");
  verifier ??= createPrivyVerifier({
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
    ...(env.PRIVY_JWT_VERIFICATION_KEY
      ? // .env files usually carry the PEM on one line with literal "\n" separators.
        { jwtVerificationKey: env.PRIVY_JWT_VERIFICATION_KEY.replaceAll("\\n", "\n") }
      : {}),
  });
  return verifier(token);
};

export const authenticatePrivyUser = createPrivyAuthenticator(
  verifyAccessToken,
  env.PRIVY_APP_ID ?? "",
);

export const authorizeBuyerConsole = createBuyerConsoleAuthorizer(
  verifyAccessToken,
  env.PRIVY_APP_ID ?? "",
  allowedUserIds,
);
