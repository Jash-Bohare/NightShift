import { Router } from "express";
import { authenticatePrivyUser } from "../buyer-console-auth.js";
import { canLaunch, canRunBuyerConsole, launchMode, publicCapabilities } from "../capabilities.js";

export const capabilitiesRouter = Router();

/** Public: which features this deployment has switched on. */
capabilitiesRouter.get("/capabilities", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json(publicCapabilities());
});

/** Signed-in: what this account may do here, with a reason when it may not. */
capabilitiesRouter.get("/me/capabilities", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const privyUserId = await authenticatePrivyUser(req.header("authorization"));
  const mode = launchMode();
  const launch = canLaunch(privyUserId);
  const console_ = canRunBuyerConsole(privyUserId);
  res.json({
    canLaunch: launch,
    ...(launch
      ? {}
      : {
          launchReason:
            mode === "off"
              ? "Launching workers is switched off on this server."
              : "This account is not permitted to launch workers on this server.",
        }),
    canRunBuyerConsole: console_,
    ...(console_
      ? {}
      : {
          buyerConsoleReason:
            publicCapabilities().buyerConsole === "off"
              ? "Paid buyer runs are switched off on this server."
              : "This account is not permitted to run the paid buyer console on this server.",
        }),
  });
});
