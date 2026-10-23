/**
 * dsh-oled-guard — client half.
 *
 * Burn-in protection for OLED displays: when the composer (input area) has been
 * idle for a few seconds, slide it out of view; reveal it again when the pointer
 * reaches the bottom edge of the window, when it receives focus, or on any key.
 *
 * Stable DOM hooks used (verified in dsh-client-ui-conversation):
 *   [data-composer-seat]   the composer region wrapper (data-conversation-region="composer")
 *   [data-composer-input]  the contenteditable editor root
 *   [role="menu"]          an open menu — never hide while one is open
 *
 * Toggle: Alt+Shift+O (persisted in localStorage).
 * Fail-open: any error leaves the stock UI untouched.
 */
window.__ModuleLoader__.load({
  id: "dsh-oled-guard",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var STYLE_ID = "dsh-oled-guard-style";
    var IDLE_MS = 4000;
    var timer = null;
    var enabled = true;
    try {
      enabled = window.localStorage.getItem("dsh-oled-guard") !== "off";
    } catch (e) {
      enabled = true;
    }

    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return;
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = [
        "[data-composer-seat]{transition:transform .34s cubic-bezier(.22,.61,.36,1),opacity .34s ease;will-change:transform,opacity;}",
        "body.dsh-oled-idle [data-composer-seat]{transform:translateY(calc(100% + 18px));opacity:0;pointer-events:none;}",
        "body.dsh-oled-off [data-composer-seat]{transform:none !important;opacity:1 !important;pointer-events:auto !important;}"
      ].join("\n");
      (document.head || document.documentElement).appendChild(style);
    }

    function seat() {
      return document.querySelector("[data-composer-seat]");
    }

    /** Only the bottom-docked composer is hidden; the centered hero input of a new chat stays visible. */
    function isDocked() {
      var element = seat();
      if (!element) return false;
      try {
        var rect = element.getBoundingClientRect();
        return rect.top > window.innerHeight * 0.6;
      } catch (e) {
        return false;
      }
    }

    function focusedInside() {
      var element = seat();
      var active = document.activeElement;
      return !!(element && active && element.contains(active));
    }

    function menuOpen() {
      return !!document.querySelector('[role="menu"]');
    }

    function show() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (document.body) document.body.classList.remove("dsh-oled-idle");
    }

    function scheduleHide() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        if (!enabled) return;
        if (!isDocked() || focusedInside() || menuOpen()) return;
        if (document.body) document.body.classList.add("dsh-oled-idle");
      }, IDLE_MS);
    }

    function onMove(event) {
      if (event.clientY > window.innerHeight - 96) show();
      else scheduleHide();
    }

    function reflectEnabled() {
      if (!document.body) return;
      document.body.classList.toggle("dsh-oled-off", !enabled);
      if (!enabled) show();
    }

    function install() {
      injectStyle();
      reflectEnabled();

      document.addEventListener("mousemove", onMove, { passive: true });
      document.addEventListener("focusin", function () { show(); }, true);
      document.addEventListener("focusout", function () { scheduleHide(); }, true);
      document.addEventListener("keydown", function (event) {
        if (event.altKey && event.shiftKey && (event.key === "O" || event.key === "o")) {
          enabled = !enabled;
          try {
            window.localStorage.setItem("dsh-oled-guard", enabled ? "on" : "off");
          } catch (e) { /* ignore */ }
          reflectEnabled();
          try {
            console.info("[dsh-oled-guard]", enabled ? "enabled" : "disabled");
          } catch (e) { /* ignore */ }
          return;
        }
        show();
      }, true);

      scheduleHide();
    }

    function apply() {
      try {
        install();
      } catch (e) {
        try {
          console.warn("[dsh-oled-guard] disabled:", e);
        } catch (err) { /* ignore */ }
      }
    }

    exports.apply = apply;
    exports.name = "dsh-oled-guard";
    return module.exports;
  }
});
