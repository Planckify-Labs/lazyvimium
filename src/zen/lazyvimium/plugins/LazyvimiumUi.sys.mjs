// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const SCHEME_PREF = "zen.view.window.scheme";
const SCHEME_DARK = 0;
const SCHEME_LIGHT = 1;

/**
 * Slide the compact sidebar out, the way leaving it with the mouse does.
 * Zen keeps it shown on the empty tab (zen-has-empty-tab); an explicit
 * <leader>e wins over that until the next tab change sets it again.
 *
 * @param {object} compact gZenCompactModeManager
 * @param {Element} sidebar
 */
function hideSidebar(compact, sidebar) {
  stopAutoHide(sidebar);
  sidebar.removeAttribute("zen-user-show");
  sidebar.removeAttribute("zen-has-empty-tab");
  if (sidebar.hasAttribute("zen-has-hover")) {
    compact._setElementExpandAttribute(sidebar, false);
  }
}

// Activity in the sidebar that keeps a <leader>e peek open.
const ACTIVITY_EVENTS = ["mousemove", "wheel", "pointerdown", "keydown"];

/** @type {WeakMap<Element, {timer: number|null, onActivity: Function}>} */
const gAutoHide = new WeakMap();

function stopAutoHide(sidebar) {
  const state = gAutoHide.get(sidebar);
  if (!state) {
    return;
  }
  sidebar.documentGlobal.clearTimeout(state.timer);
  for (const type of ACTIVITY_EVENTS) {
    sidebar.removeEventListener(type, state.onActivity, true);
  }
  gAutoHide.delete(sidebar);
}

/**
 * Slide a peeked sidebar back out after `delay` ms without activity in it,
 * like the mouse leaving it. It stays while hovered, while one of its menus
 * is open or while it has keyboard focus (renaming a tab, say).
 *
 * @param {object} compact gZenCompactModeManager
 * @param {Element} sidebar
 * @param {number} delay
 */
function startAutoHide(compact, sidebar, delay) {
  stopAutoHide(sidebar);
  if (!(delay > 0)) {
    return;
  }
  const window = sidebar.documentGlobal;
  const state = { timer: null, onActivity: null };
  const check = () => {
    if (!sidebar.hasAttribute("zen-user-show")) {
      stopAutoHide(sidebar);
      return;
    }
    const busy =
      sidebar.hasAttribute("zen-has-hover") ||
      sidebar.hasAttribute("has-popup-menu") ||
      sidebar.hasAttribute("zen-compact-mode-active") ||
      sidebar.contains(window.document.activeElement);
    if (busy) {
      restart();
    } else {
      hideSidebar(compact, sidebar);
    }
  };
  const restart = () => {
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(check, delay);
  };
  state.onActivity = restart;
  for (const type of ACTIVITY_EVENTS) {
    sidebar.addEventListener(type, restart, true);
  }
  gAutoHide.set(sidebar, state);
  restart();
}

export const LazyvimiumUiSpec = {
  name: "ui",
  opts: {
    explorer: {
      // Milliseconds a <leader>e peek stays open without activity; 0 keeps
      // it open until <leader>e again.
      autoHide: 3000,
    },
  },
  actions: {
    "ui.toggleDark": {
      desc: "Toggle Dark Background",
      agent: "act",
      run({ window }) {
        const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        Services.prefs.setIntPref(
          SCHEME_PREF,
          dark ? SCHEME_LIGHT : SCHEME_DARK
        );
      },
    },
    "ui.explorer": {
      desc: "Explorer (Compact Mode)",
      agent: "act",
      run({ window, opts }) {
        const compact = window.gZenCompactModeManager;
        const sidebar = compact.sidebar;
        if (!compact.preference) {
          compact.preference = true;
          hideSidebar(compact, sidebar);
          return;
        }
        if (compact.isSidebarPotentiallyOpen()) {
          hideSidebar(compact, sidebar);
        } else {
          // The attribute hovering the screen edge sets, with its slide in.
          sidebar.setAttribute("zen-user-show", "true");
          startAutoHide(compact, sidebar, opts.explorer?.autoHide);
        }
      },
    },
    "ui.readerMode": {
      desc: "Toggle Reader Mode",
      agent: "act",
      run: ({ window }) =>
        window.document.getElementById("View:ReaderView").doCommand(),
    },
    "ui.dismissNotifications": {
      desc: "Dismiss All Notifications",
      agent: "act",
      run({ window, browser }) {
        window.gBrowser
          .getNotificationBox(browser)
          .removeAllNotifications(true);
        window.gNotificationBox?.removeAllNotifications(true);
      },
    },
  },
};
