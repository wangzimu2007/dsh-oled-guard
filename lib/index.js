/**
 * dsh-oled-guard — host half.
 *
 * The client half hides the composer, sidebar, right panel, headers and fixed
 * overlays when idle. The native Electron menu bar ("应用 / 编辑") is not part
 * of the DOM, so the host half removes it from each window once. It deliberately
 * does not poll: repeatedly resetting the application menu made the whole top
 * bar relayout and flicker.
 *
 * Fail-open on every path.
 */
const PACKAGE_ID = "dsh-oled-guard";
const boundWindows = new WeakSet();

function hideNativeMenu(win) {
  if (!win) return;
  try {
    if (typeof win.isDestroyed === "function" && win.isDestroyed()) return;
    if (typeof win.setAutoHideMenuBar === "function") win.setAutoHideMenuBar(false);
    if (typeof win.removeMenu === "function") win.removeMenu();
    if (typeof win.setMenuBarVisibility === "function") win.setMenuBarVisibility(false);
  } catch {
    /* never fail the host tree */
  }
}

function bindWindow(win) {
  if (!win) return;
  try {
    if (boundWindows.has(win)) return;
    boundWindows.add(win);
    hideNativeMenu(win);
    if (typeof win.once === "function") {
      win.once("ready-to-show", () => hideNativeMenu(win));
    }
  } catch {
    /* ignore */
  }
}

function installMenuAutoHide(electron, ctx) {
  try {
    const BrowserWindow = electron && electron.BrowserWindow;
    const app = electron && electron.app;
    const Menu = electron && electron.Menu;
    if (!BrowserWindow) return;

    // Remove the application menu once. Doing this on an interval (the old
    // implementation) reflowed the native top bar twice a second.
    try {
      if (Menu && typeof Menu.setApplicationMenu === "function") Menu.setApplicationMenu(null);
    } catch {
      /* ignore */
    }

    const applyAll = () => {
      try {
        const windows = typeof BrowserWindow.getAllWindows === "function"
          ? BrowserWindow.getAllWindows()
          : [];
        for (const win of windows) bindWindow(win);
      } catch {
        /* ignore */
      }
    };

    applyAll();
    if (app) {
      try {
        app.whenReady().then(applyAll).catch(() => {});
      } catch {
        /* ignore */
      }
      try {
        app.on("browser-window-created", (_event, win) => bindWindow(win));
      } catch {
        /* ignore */
      }
    }
  } catch (error) {
    try {
      if (ctx && typeof ctx.logger === "function") {
        const logger = ctx.logger(PACKAGE_ID);
        if (logger && typeof logger.warn === "function") {
          logger.warn("native menu auto-hide unavailable:", error);
        }
      }
    } catch {
      /* ignore */
    }
  }
}

export function apply(ctx) {
  try {
    const logger = ctx && typeof ctx.logger === "function" ? ctx.logger(PACKAGE_ID) : null;
    if (logger && typeof logger.info === "function") {
      logger.info("client bundle loaded; composer/sidebar/rightbar auto-hide + native menu removed once");
    }
  } catch {
    /* ignore */
  }

  try {
    // Host plugins run in the Electron main process; dynamic import keeps the
    // module loadable in environments where Electron is not present.
    import("electron")
      .then((electron) => installMenuAutoHide(electron, ctx))
      .catch(() => {
        /* web/headless host: menu is not applicable */
      });
  } catch {
    /* ignore */
  }
}
