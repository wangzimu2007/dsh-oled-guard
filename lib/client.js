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
    var overlayEnabled = true;
    var overlayScanTimer = null;
    var overlayEls = [];
    var overlayObserver = null;
    try {
      enabled = window.localStorage.getItem("dsh-oled-guard") !== "off";
      overlayEnabled = window.localStorage.getItem("dsh-oled-guard-overlays") !== "off";
    } catch (e) {
      enabled = true;
      overlayEnabled = true;
    }

    function readSelectorList(key) {
      try {
        var raw = window.localStorage.getItem(key);
        if (!raw) return [];
        var parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(function (v) { return typeof v === "string" && v.trim(); }) : [];
      } catch (e) {
        return [];
      }
    }

    var extraSelectors = readSelectorList("dsh-oled-guard-extra");
    var excludeSelectors = readSelectorList("dsh-oled-guard-exclude");

    /* ---- configurable hotkeys + settings panel ---- */

    var HOTKEY_CONFIG_KEY = "dsh-oled-guard-hotkeys";
    var DISABLED_KEY = "dsh-oled-guard";
    var OVERLAY_KEY = "dsh-oled-guard-overlays";
    var DEFAULT_HOTKEYS = {
      toggleAll: "Alt+Shift+O",
      toggleOverlays: "Alt+Shift+P",
      openSettings: "Alt+Shift+K"
    };
    var settingsOpen = false;
    var settingsEl = null;
    var settingsStatus = null;
    var hotkeys = loadHotkeys();

    function normalizeKeyName(name) {
      var key = String(name || "").toLowerCase();
      if (key === "esc") return "escape";
      if (key === "space" || key === "spacebar") return " ";
      if (key === "up") return "arrowup";
      if (key === "down") return "arrowdown";
      if (key === "left") return "arrowleft";
      if (key === "right") return "arrowright";
      return key;
    }

    function parseHotkey(value) {
      var raw = String(value || "").trim();
      if (!raw) return null;
      var parts = raw.split("+").map(function (s) { return s.trim(); }).filter(Boolean);
      if (parts.length < 1) return null;
      var key = parts.pop();
      var modifiers = { ctrl: false, alt: false, shift: false, meta: false };
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i].toLowerCase();
        if (part === "ctrl" || part === "control") modifiers.ctrl = true;
        else if (part === "alt" || part === "option") modifiers.alt = true;
        else if (part === "shift") modifiers.shift = true;
        else if (part === "meta" || part === "cmd" || part === "command" || part === "win") modifiers.meta = true;
        else return null;
      }
      if (!key) return null;
      return {
        ctrl: modifiers.ctrl,
        alt: modifiers.alt,
        shift: modifiers.shift,
        meta: modifiers.meta,
        key: normalizeKeyName(key)
      };
    }

    function isValidHotkey(value) {
      var parsed = parseHotkey(value);
      if (!parsed) return false;
      if (/^f([1-9]|1[0-2])$/.test(parsed.key)) return true;
      return parsed.ctrl || parsed.alt || parsed.shift || parsed.meta;
    }

    function loadHotkeys() {
      var result = {
        toggleAll: DEFAULT_HOTKEYS.toggleAll,
        toggleOverlays: DEFAULT_HOTKEYS.toggleOverlays,
        openSettings: DEFAULT_HOTKEYS.openSettings
      };
      try {
        var raw = window.localStorage.getItem(HOTKEY_CONFIG_KEY);
        if (raw) {
          var stored = JSON.parse(raw);
          for (var key in result) {
            if (stored && typeof stored[key] === "string" && isValidHotkey(stored[key])) {
              result[key] = stored[key];
            }
          }
        }
      } catch (e) { /* ignore malformed config */ }
      // De-duplicate: any duplicate falls back to the default for that slot.
      var used = {};
      for (var name in result) {
        var value = result[name];
        if (used[value]) result[name] = DEFAULT_HOTKEYS[name];
        used[result[name]] = true;
      }
      return result;
    }

    function saveHotkeys(next) {
      hotkeys = next;
      try {
        window.localStorage.setItem(HOTKEY_CONFIG_KEY, JSON.stringify(next));
      } catch (e) { /* ignore */ }
    }

    function matchesHotkey(event, combo) {
      var parsed = parseHotkey(combo);
      if (!parsed) return false;
      if (event.ctrlKey !== parsed.ctrl || event.altKey !== parsed.alt ||
          event.shiftKey !== parsed.shift || event.metaKey !== parsed.meta) return false;
      return normalizeKeyName(event.key) === parsed.key;
    }

    function comboFromEvent(event) {
      var key = event.key || "";
      if (key === "Control" || key === "Alt" || key === "Shift" || key === "Meta") return null;
      var parts = [];
      if (event.ctrlKey) parts.push("Ctrl");
      if (event.altKey) parts.push("Alt");
      if (event.shiftKey) parts.push("Shift");
      if (event.metaKey) parts.push("Meta");
      var label = key.length === 1 ? key.toUpperCase() : key;
      if (label === " ") label = "Space";
      if (label === "+") label = "Plus";
      parts.push(label);
      return parts.join("+");
    }

    function setSettingsStatus(text, isError) {
      if (!settingsStatus) return;
      settingsStatus.textContent = text || "";
      settingsStatus.classList.toggle("error", !!isError);
    }

    function closeSettingsPanel() {
      settingsOpen = false;
      if (settingsEl) settingsEl.style.display = "none";
      scheduleHide();
    }

    function ensureSettingsPanel() {
      if (settingsEl && !settingsEl.isConnected) {
        settingsEl = null;
        settingsStatus = null;
      }
      if (settingsEl || !document.body) return settingsEl;
      var panel = document.createElement("div");
      panel.className = "dsh-oled-settings";
      panel.setAttribute("data-dsh-oled-keep", "");
      panel.innerHTML = [
        '<div class="dsh-oled-settings-title">防烧屏设置</div>',
        '<label class="dsh-oled-settings-row"><input type="checkbox" data-role="enabled"> 启用防烧屏（输入框 / 鲸鱼 / 浮层）</label>',
        '<label class="dsh-oled-settings-row"><input type="checkbox" data-role="overlays"> 隐藏固定浮层（侧边栏 / 顶栏 / 徽章等）</label>',
        '<div class="dsh-oled-settings-hotkeys">',
        '  <label>总开关 <input type="text" readonly data-hotkey="toggleAll"></label>',
        '  <label>浮层开关 <input type="text" readonly data-hotkey="toggleOverlays"></label>',
        '  <label>打开设置 <input type="text" readonly data-hotkey="openSettings"></label>',
        '</div>',
        '<div class="dsh-oled-settings-actions">',
        '  <button type="button" data-action="save">保存</button>',
        '  <button type="button" data-action="reset">恢复默认</button>',
        '  <button type="button" data-action="close">关闭</button>',
        '</div>',
        '<div class="dsh-oled-settings-status"></div>',
        '<p class="dsh-oled-settings-hint">点击快捷键输入框后按下新组合键；字母键必须带 Ctrl / Alt / Shift / Meta 修饰。</p>'
      ].join("");
      document.body.appendChild(panel);
      settingsEl = panel;
      settingsStatus = panel.querySelector(".dsh-oled-settings-status");

      panel.querySelectorAll("[data-hotkey]").forEach(function (input) {
        input.addEventListener("focus", function () { input.select(); });
        input.addEventListener("keydown", function (event) {
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") {
            input.blur();
            return;
          }
          var combo = comboFromEvent(event);
          if (!combo) return;
          input.value = combo;
          setSettingsStatus("", false);
        });
      });

      panel.addEventListener("click", function (event) {
        var action = event.target && event.target.getAttribute && event.target.getAttribute("data-action");
        if (!action) return;
        if (action === "close") {
          closeSettingsPanel();
          return;
        }
        if (action === "reset") {
          panel.querySelector('[data-hotkey="toggleAll"]').value = DEFAULT_HOTKEYS.toggleAll;
          panel.querySelector('[data-hotkey="toggleOverlays"]').value = DEFAULT_HOTKEYS.toggleOverlays;
          panel.querySelector('[data-hotkey="openSettings"]').value = DEFAULT_HOTKEYS.openSettings;
          setSettingsStatus("已填入默认快捷键，点保存生效", false);
          return;
        }
        if (action === "save") {
          var next = {
            toggleAll: panel.querySelector('[data-hotkey="toggleAll"]').value.trim(),
            toggleOverlays: panel.querySelector('[data-hotkey="toggleOverlays"]').value.trim(),
            openSettings: panel.querySelector('[data-hotkey="openSettings"]').value.trim()
          };
          for (var name in next) {
            if (!isValidHotkey(next[name])) {
              setSettingsStatus("快捷键无效：字母/数字键必须带 Ctrl / Alt / Shift / Meta", true);
              return;
            }
          }
          var values = [next.toggleAll, next.toggleOverlays, next.openSettings];
          if (new Set(values).size !== 3) {
            setSettingsStatus("三个快捷键不能重复", true);
            return;
          }
          var nextEnabled = panel.querySelector('[data-role="enabled"]').checked;
          var nextOverlay = panel.querySelector('[data-role="overlays"]').checked;
          saveHotkeys(next);
          enabled = nextEnabled;
          overlayEnabled = nextOverlay;
          try {
            window.localStorage.setItem(DISABLED_KEY, enabled ? "on" : "off");
            window.localStorage.setItem(OVERLAY_KEY, overlayEnabled ? "on" : "off");
          } catch (e) { /* ignore */ }
          reflectEnabled();
          if (!overlayEnabled) showOverlays();
          closeSettingsPanel();
          try {
            console.info("[dsh-oled-guard] settings saved", hotkeys, { enabled: enabled, overlays: overlayEnabled });
          } catch (e) { /* ignore */ }
        }
      });
      return panel;
    }

    function openSettingsPanel() {
      var panel = ensureSettingsPanel();
      if (!panel) return;
      panel.querySelector('[data-role="enabled"]').checked = enabled;
      panel.querySelector('[data-role="overlays"]').checked = overlayEnabled;
      panel.querySelector('[data-hotkey="toggleAll"]').value = hotkeys.toggleAll;
      panel.querySelector('[data-hotkey="toggleOverlays"]').value = hotkeys.toggleOverlays;
      panel.querySelector('[data-hotkey="openSettings"]').value = hotkeys.openSettings;
      setSettingsStatus("", false);
      settingsOpen = true;
      panel.style.display = "block";
      show();
    }

    function toggleAllProtection() {
      enabled = !enabled;
      try {
        window.localStorage.setItem(DISABLED_KEY, enabled ? "on" : "off");
      } catch (e) { /* ignore */ }
      reflectEnabled();
      if (enabled) scheduleHide();
      try {
        console.info("[dsh-oled-guard]", enabled ? "enabled" : "disabled");
      } catch (e) { /* ignore */ }
    }

    function toggleOverlayProtection() {
      overlayEnabled = !overlayEnabled;
      try {
        window.localStorage.setItem(OVERLAY_KEY, overlayEnabled ? "on" : "off");
      } catch (e) { /* ignore */ }
      if (!overlayEnabled) {
        showOverlays();
      } else if (document.body && document.body.classList.contains("dsh-oled-idle")) {
        hideOverlays();
      }
      try {
        console.info("[dsh-oled-guard] fixed overlays", overlayEnabled ? "enabled" : "disabled");
      } catch (e) { /* ignore */ }
    }

    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return;
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = [
        "[data-composer-seat]{transition:transform .34s cubic-bezier(.22,.61,.36,1),opacity .34s ease;will-change:transform,opacity;}",
        "body.dsh-oled-idle [data-composer-seat]{transform:translateY(calc(100% + 18px));opacity:0;pointer-events:none;}",
        "body.dsh-oled-idle .dshwv-root{opacity:0 !important;transition:opacity .5s ease;}",
        "body.dsh-oled-idle .dshwv-root *{pointer-events:none !important;}",
        "body.dsh-oled-off .dshwv-root{opacity:1 !important;}",
        ".dsh-oled-overlay{transition:opacity .45s ease;}",
        "body.dsh-oled-overlays-hidden .dsh-oled-overlay{opacity:0 !important;pointer-events:none !important;}",
        ".dsh-oled-settings{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483000;width:400px;max-width:calc(100vw - 24px);box-sizing:border-box;background:rgba(20,26,40,.97);color:#e8eeff;border:1px solid rgba(110,140,255,.35);border-radius:12px;padding:16px 18px;box-shadow:0 18px 50px rgba(0,0,0,.55);font-size:13px;line-height:1.5;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;}",
        ".dsh-oled-settings-title{font-size:15px;font-weight:600;margin-bottom:10px;}",
        ".dsh-oled-settings-row{display:flex;align-items:center;gap:8px;margin:8px 0;cursor:pointer;}",
        ".dsh-oled-settings-row input{accent-color:#5b8cff;}",
        ".dsh-oled-settings-hotkeys{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;margin:12px 0;}",
        ".dsh-oled-settings-hotkeys label{display:flex;flex-direction:column;gap:4px;color:#b9c6e6;font-size:12px;}",
        ".dsh-oled-settings-hotkeys input{width:100%;box-sizing:border-box;background:#0f1626;border:1px solid rgba(120,150,255,.3);border-radius:6px;color:#e8eeff;padding:6px 8px;font-size:12px;outline:none;}",
        ".dsh-oled-settings-hotkeys input:focus{border-color:#5b8cff;}",
        ".dsh-oled-settings-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px;}",
        ".dsh-oled-settings-actions button{background:#2b3a5e;color:#fff;border:1px solid rgba(120,150,255,.35);border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px;}",
        ".dsh-oled-settings-actions button[data-action=save]{background:#3557a8;}",
        ".dsh-oled-settings-actions button:hover{filter:brightness(1.15);}",
        ".dsh-oled-settings-status{min-height:18px;margin-top:8px;font-size:12px;color:#9fd8a8;}",
        ".dsh-oled-settings-status.error{color:#ff8f8f;}",
        ".dsh-oled-settings-hint{color:#7f8ba8;font-size:11px;margin:8px 0 0;}",
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

    /* ---- dsh-whale-widget (the bottom-right whale) ---- */

    function whaleRoot() {
      return document.querySelector(".dshwv-root");
    }

    /** Pointer is on or near the whale (draggable, so use its live rect instead of a corner). */
    function whaleNear(x, y) {
      var element = whaleRoot();
      if (!element) return false;
      try {
        var rect = element.getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) return false;
        var pad = 80;
        return x > rect.left - pad && x < rect.right + pad && y > rect.top - pad && y < rect.bottom + pad;
      } catch (e) {
        return false;
      }
    }

    /** Never hide while one of the whale's menus / bubbles is visible. */
    function whaleUiOpen() {
      var nodes = document.querySelectorAll(".dshwv-menu, .dshwv-bubble, .dshwv-usagepanel");
      for (var i = 0; i < nodes.length; i++) {
        try {
          var style = window.getComputedStyle(nodes[i]);
          if (style.display !== "none" && parseFloat(style.opacity || "1") > 0.05) return true;
        } catch (e) {
          /* ignore */
        }
      }
      return false;
    }

    /* ---- other fixed / sticky UI (sidebar, top bar, usage rings, badges, toasts) ---- */

    function selectorsMatch(el, selectors) {
      for (var i = 0; i < selectors.length; i++) {
        try {
          if (el.matches(selectors[i]) || el.closest(selectors[i])) return true;
        } catch (e) {
          /* invalid user selector: ignore */
        }
      }
      return false;
    }

    function overlayExcluded(el) {
      if (el.closest("[data-dsh-oled-keep]")) return true;
      if (el.closest("[data-composer-seat], .dshwv-root")) return true;
      // Open menus/dialogs/tooltips must stay interactive; the idle guard never fires while one is open.
      if (el.closest('[role="menu"], [role="dialog"], [role="alertdialog"], [role="tooltip"]')) return true;
      // Common UI kit overlays
      if (el.closest(".el-popper, .el-overlay, .ant-popover, .ant-modal, .ant-notification, .ant-message")) return true;
      if (document.activeElement && el.contains(document.activeElement)) return true;
      if (excludeSelectors.length && selectorsMatch(el, excludeSelectors)) return true;
      return false;
    }

    function isOverlayCandidate(el) {
      if (!el || el === document.body || el === document.documentElement) return false;
      var style;
      try {
        style = window.getComputedStyle(el);
      } catch (e) {
        return false;
      }
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (parseFloat(style.opacity || "1") <= 0.01) return false;

      var forced = extraSelectors.length > 0 && selectorsMatch(el, extraSelectors);
      if (!forced && style.position !== "fixed" && style.position !== "sticky") return false;

      var rect;
      try {
        rect = el.getBoundingClientRect();
      } catch (e) {
        return false;
      }
      if (rect.width < 8 || rect.height < 8) return false;
      // Full-screen layers are usually backdrops/wallpapers; keep them (black would hide content too).
      if (rect.width * rect.height > window.innerWidth * window.innerHeight * 0.6) return false;
      if (overlayExcluded(el)) return false;
      return true;
    }

    function hideOverlays() {
      if (!enabled || !overlayEnabled || !document.body) return;
      var nodes = document.body.getElementsByTagName("*");
      var list = [];
      for (var i = 0; i < nodes.length; i++) {
        if (isOverlayCandidate(nodes[i])) {
          try {
            nodes[i].classList.add("dsh-oled-overlay");
            list.push(nodes[i]);
          } catch (e) {
            /* ignore */
          }
        }
      }
      overlayEls = list;
      document.body.classList.add("dsh-oled-overlays-hidden");
      if (list.length > 0) {
        try {
          console.debug("[dsh-oled-guard] hidden fixed overlays:", list.length);
        } catch (e) { /* ignore */ }
      }
    }

    function showOverlays() {
      for (var i = 0; i < overlayEls.length; i++) {
        try {
          overlayEls[i].classList.remove("dsh-oled-overlay");
        } catch (e) { /* ignore */ }
      }
      overlayEls = [];
      if (document.body) document.body.classList.remove("dsh-oled-overlays-hidden");
    }

    function scheduleOverlayRescan() {
      if (!document.body || !document.body.classList.contains("dsh-oled-overlays-hidden")) return;
      if (overlayScanTimer !== null) clearTimeout(overlayScanTimer);
      overlayScanTimer = setTimeout(function () {
        overlayScanTimer = null;
        if (!document.body || !document.body.classList.contains("dsh-oled-overlays-hidden")) return;
        showOverlays();
        hideOverlays();
      }, 400);
    }

    function show() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      showOverlays();
      if (document.body) document.body.classList.remove("dsh-oled-idle");
    }

    function scheduleHide() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        if (!enabled) return;
        if (settingsOpen || !isDocked() || focusedInside() || menuOpen() || whaleUiOpen()) return;
        if (document.body) {
          document.body.classList.add("dsh-oled-idle");
          hideOverlays();
        }
      }, IDLE_MS);
    }

    function onMove(event) {
      // Fixed overlays reappear on any real pointer movement; the composer stays bottom-triggered.
      if (document.body && document.body.classList.contains("dsh-oled-overlays-hidden") &&
          (event.movementX || event.movementY)) {
        showOverlays();
      }
      if (event.clientY > window.innerHeight - 96 || whaleNear(event.clientX, event.clientY)) show();
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
        if (settingsOpen) {
          if (event.key === "Escape") {
            event.preventDefault();
            closeSettingsPanel();
          }
          return;
        }
        if (matchesHotkey(event, hotkeys.openSettings)) {
          event.preventDefault();
          openSettingsPanel();
          return;
        }
        if (matchesHotkey(event, hotkeys.toggleAll)) {
          event.preventDefault();
          toggleAllProtection();
          return;
        }
        if (matchesHotkey(event, hotkeys.toggleOverlays)) {
          event.preventDefault();
          toggleOverlayProtection();
          return;
        }
        show();
      }, true);

      try {
        overlayObserver = new MutationObserver(scheduleOverlayRescan);
        overlayObserver.observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) {
        overlayObserver = null;
      }

      scheduleHide();
    }

    function apply() {
      try {
        install();
        try {
          // Escape hatch if the user forgets a customized hotkey.
          window.__dshOledGuard = {
            openSettings: openSettingsPanel,
            closeSettings: closeSettingsPanel,
            toggleAll: toggleAllProtection,
            toggleOverlays: toggleOverlayProtection,
            show: show
          };
        } catch (e) { /* ignore */ }
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
