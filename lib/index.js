/**
 * dsh-oled-guard — host half (no logic).
 * The whole feature lives in the client half (lib/client.js). This file only
 * makes the package a real entry in the host cordis tree, so dsh-client-modules
 * discovers and serves the client bundle.
 */
const PACKAGE_ID = "dsh-oled-guard";

export function apply(ctx) {
  try {
    const logger = ctx && typeof ctx.logger === "function" ? ctx.logger(PACKAGE_ID) : null;
    if (logger && typeof logger.info === "function") {
      logger.info("client bundle loaded; composer auto-hide handled in the web client");
    }
  } catch {
    /* never fail the host tree */
  }
}
