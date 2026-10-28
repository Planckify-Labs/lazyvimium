// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { LazyvimiumActions } from "resource:///modules/lazyvimium/core/LazyvimiumActions.sys.mjs";
import { LazyvimiumKeymap } from "resource:///modules/lazyvimium/core/LazyvimiumKeymap.sys.mjs";
import { LazyvimiumKeys } from "resource:///modules/lazyvimium/core/LazyvimiumKeys.sys.mjs";
import { LazyvimiumPlugins } from "resource:///modules/lazyvimium/core/LazyvimiumPlugins.sys.mjs";
import {
  LAZYVIMIUM_SHARED_KEY,
  serializeConfig,
} from "resource:///modules/lazyvimium/core/LazyvimiumShared.sys.mjs";
import { LazyvimiumKeymapsSpec } from "resource:///modules/lazyvimium/config/LazyvimiumKeymaps.sys.mjs";
import { LazyvimiumOptions } from "resource:///modules/lazyvimium/config/LazyvimiumOptions.sys.mjs";
import { LazyvimiumCoreSpec } from "resource:///modules/lazyvimium/plugins/LazyvimiumCore.sys.mjs";
import { LazyvimiumEditSpec } from "resource:///modules/lazyvimium/plugins/LazyvimiumEdit.sys.mjs";
import { LazyvimiumFindSpec } from "resource:///modules/lazyvimium/plugins/LazyvimiumFind.sys.mjs";
import { LazyvimiumInputsSpec } from "resource:///modules/lazyvimium/plugins/LazyvimiumInputs.sys.mjs";
import { LazyvimiumLibrarySpec } from "resource:///modules/lazyvimium/plugins/LazyvimiumLibrary.sys.mjs";
import { LazyvimiumNavigationSpec } from "resource:///modules/lazyvimium/plugins/LazyvimiumNavigation.sys.mjs";
import { LazyvimiumScrollSpec } from "resource:///modules/lazyvimium/plugins/LazyvimiumScroll.sys.mjs";
import { LazyvimiumSessionSpec } from "resource:///modules/lazyvimium/plugins/LazyvimiumSession.sys.mjs";
import { LazyvimiumTabsSpec } from "resource:///modules/lazyvimium/plugins/LazyvimiumTabs.sys.mjs";
import { LazyvimiumUiSpec } from "resource:///modules/lazyvimium/plugins/LazyvimiumUi.sys.mjs";
import { LazyvimiumWhichKeySpec } from "resource:///modules/lazyvimium/plugins/LazyvimiumWhichKeySpec.sys.mjs";
import { LazyvimiumWindowsSpec } from "resource:///modules/lazyvimium/plugins/LazyvimiumWindows.sys.mjs";
import { LazyvimiumZenCommandsSpec } from "resource:///modules/lazyvimium/plugins/LazyvimiumZenCommands.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ActorManagerParent: "resource://gre/modules/ActorManagerParent.sys.mjs",
  LazyvimiumStatusline:
    "resource:///modules/lazyvimium/ui/LazyvimiumStatusline.sys.mjs",
  LazyvimiumWhichKey:
    "resource:///modules/lazyvimium/ui/LazyvimiumWhichKey.sys.mjs",
});

const LAZYVIMIUM_STYLESHEET =
  "resource:///modules/lazyvimium/ui/lazyvimium.css";

/**
 * The built-in specs, in the order LazyVim imports its own.
 */
export const LAZYVIMIUM_SPECS = [
  LazyvimiumCoreSpec,
  LazyvimiumScrollSpec,
  LazyvimiumTabsSpec,
  LazyvimiumNavigationSpec,
  LazyvimiumInputsSpec,
  LazyvimiumEditSpec,
  LazyvimiumFindSpec,
  LazyvimiumWindowsSpec,
  LazyvimiumLibrarySpec,
  LazyvimiumUiSpec,
  LazyvimiumSessionSpec,
  LazyvimiumZenCommandsSpec,
  LazyvimiumWhichKeySpec,
  LazyvimiumKeymapsSpec,
];

function windowOf(browser) {
  return browser?.documentGlobal ?? null;
}

// LazyVim keeps the UI out of the way of the text. With vim mode on, the
// browser starts in Zen's compact mode hiding both the sidebar and the
// toolbar. These are defaults: what the user picks in Zen's menu still wins.
const VIM_MODE_DEFAULTS = {
  "zen.view.compact.enable-at-startup": true,
  "zen.view.compact.hide-tabbar": true,
  "zen.view.compact.hide-toolbar": true,
};

const NORMAL_STATE = Object.freeze({
  mode: "n",
  tokens: [],
  count: null,
  group: null,
  field: false,
});

// Browser shortcuts marked reserved="true" never reach the page, so the
// content actor cannot take them; the parent does when the page's mode maps
// them. Ctrl+W, for one, would otherwise close the tab while typing.
// On macOS the reserved ones use Cmd, and Ctrl+W already reaches the page.
const RESERVED_TOKENS = new Set(
  ["w", "t", "n", "S-w", "S-n"].map(
    key => `<${AppConstants.platform == "macosx" ? "D" : "C"}-${key}>`
  )
);

/**
 * Read the user's lazyvimium.json, the counterpart of LazyVim's lazyvim.json
 * and lua/config/keymaps.lua:
 *
 *   {
 *     "extras": ["ublock"],
 *     "plugins": [{ "name": "scroll", "opts": { "step": 80 } }],
 *     "keymaps": [["n", "J", "tabs.next"], ["n", "<S-l>", false]]
 *   }
 *
 * @param {*} data
 * @returns {{extras: string[], overrides: object[]}}
 */
export function parseUserConfig(data) {
  if (typeof data != "object" || data === null || Array.isArray(data)) {
    throw new Error("Lazyvimium: lazyvimium.json must hold an object");
  }
  const { extras = [], plugins = [], keymaps = [] } = data;
  if (!Array.isArray(extras) || extras.some(name => typeof name != "string")) {
    throw new Error('Lazyvimium: "extras" must be a list of names');
  }
  if (!Array.isArray(plugins)) {
    throw new Error('Lazyvimium: "plugins" must be a list of specs');
  }
  if (!Array.isArray(keymaps)) {
    throw new Error('Lazyvimium: "keymaps" must be a list of keys');
  }
  const overrides = [...plugins];
  if (keymaps.length) {
    overrides.push({ name: "user", priority: 1000, keys: keymaps });
  }
  return { extras, overrides };
}

class LazyvimiumService {
  actions = new LazyvimiumActions();
  /** @type {LazyvimiumKeymap|null} */
  keymap = null;
  /** @type {LazyvimiumPlugins|null} */
  plugins = null;
  /** The report of the last plugin load, for the health page. */
  report = null;
  /** Why lazyvimium.json could not be used, if it could not. */
  userConfigError = null;

  #initialized = false;
  #version = 0;
  #user = { extras: [], overrides: [] };
  #zenCommands = [];
  /** @type {WeakMap<Element, object>} */
  #states = new WeakMap();
  /**
   * The statusline and which-key popup of each browser window, keyed by
   * document, which a browser element reaches as ownerDocument.
   *
   * @type {Map<Document, {statusline: object, whichKey: object}>}
   */
  #windows = new Map();

  get userConfigPath() {
    return PathUtils.join(
      PathUtils.profileDir,
      "lazyvimium",
      "lazyvimium.json"
    );
  }

  init() {
    if (this.#initialized) {
      return;
    }
    this.#initialized = true;
    if (LazyvimiumOptions.enabled) {
      const defaults = Services.prefs.getDefaultBranch("");
      for (const [name, value] of Object.entries(VIM_MODE_DEFAULTS)) {
        defaults.setBoolPref(name, value);
      }
    }
    this.keymap = new LazyvimiumKeymap({ leader: LazyvimiumOptions.leader });
    this.plugins = new LazyvimiumPlugins({
      actions: this.actions,
      keymap: this.keymap,
    });
    this.#registerActor();
    this.reload();
    for (const pref of [
      LazyvimiumOptions.PREF_ENABLED,
      LazyvimiumOptions.PREF_LEADER,
      LazyvimiumOptions.PREF_TIMEOUTLEN,
      LazyvimiumOptions.PREF_STATUSLINE,
    ]) {
      Services.prefs.addObserver(pref, this);
    }
    this.loadUserConfig();
  }

  observe(subject, topic, data) {
    if (topic != "nsPref:changed") {
      return;
    }
    switch (data) {
      case LazyvimiumOptions.PREF_LEADER:
        this.keymap.setLeader(LazyvimiumOptions.leader);
        this.reload();
        break;
      case LazyvimiumOptions.PREF_TIMEOUTLEN:
        this.#publish();
        break;
      case LazyvimiumOptions.PREF_ENABLED:
      case LazyvimiumOptions.PREF_STATUSLINE:
        for (const { statusline } of this.#windows.values()) {
          statusline.setVisible(this.#statuslineVisible);
        }
        break;
    }
  }

  /**
   * Load every spec again and publish the result to content processes.
   */
  reload() {
    this.report = this.plugins.load({
      specs: [
        ...LAZYVIMIUM_SPECS,
        { name: "zen-commands", opts: { commands: this.#zenCommands } },
      ],
      extras: this.#user.extras,
      overrides: this.#user.overrides,
    });
    this.#publish();
  }

  async loadUserConfig() {
    const path = this.userConfigPath;
    try {
      if (!(await IOUtils.exists(path))) {
        return;
      }
      this.#user = parseUserConfig(await IOUtils.readJSON(path));
      this.userConfigError = null;
    } catch (e) {
      this.userConfigError = e;
      console.error(`Lazyvimium: could not use ${path}`, e);
      return;
    }
    this.reload();
  }

  /**
   * Run a parent action a page asked for through a key. A content process
   * can only trigger actions the keymap points at.
   *
   * @param {Element} browser
   * @param {string} id
   * @param {object} args
   */
  async runFromKey(browser, id, args) {
    const action = this.actions.get(id);
    if (action?.where != "parent" || !this.keymap.maps(id)) {
      console.error(`Lazyvimium: a page asked for unmapped action "${id}"`);
      return;
    }
    if (!windowOf(browser)?.gBrowser) {
      return;
    }
    try {
      await this.run(id, args, { browser });
    } catch (e) {
      console.error(`Lazyvimium: "${id}" failed`, e);
    }
  }

  /**
   * Run any action, the way the command line and agents will.
   *
   * @param {string} id
   * @param {object} [args]
   * @param {object} [target]
   * @param {Window} [target.window] Defaults to the most recent browser
   *   window.
   * @param {Element} [target.browser] Defaults to that window's selected
   *   browser.
   * @returns {Promise<*>}
   */
  run(id, args = {}, { window, browser } = {}) {
    window ??=
      windowOf(browser) ?? Services.wm.getMostRecentWindow("navigator:browser");
    browser ??= window.gBrowser.selectedBrowser;
    const owner = this.actions.get(id)?.owner;
    return this.actions.run(
      id,
      {
        window,
        browser,
        gBrowser: window.gBrowser,
        opts: this.plugins.get(owner)?.opts ?? {},
        lazyvimium: this,
        runContent: (action, contentArgs) =>
          browser.browsingContext.currentWindowGlobal
            .getActor("LazyvimiumKeys")
            .sendQuery("Lazyvimium:RunContent", {
              id: action.id,
              args: contentArgs,
            }),
      },
      args
    );
  }

  /**
   * @param {Element} browser
   * @param {object} state What the page's key engine reported.
   * @param {string} state.mode
   * @param {string[]} state.tokens
   * @param {number|null} state.count
   * @param {string|null} state.group
   * @param {boolean} state.field Whether a page field has focus.
   */
  updateState(browser, { mode, tokens, count, group, field } = {}) {
    const text = (value, max) =>
      typeof value == "string" ? value.slice(0, max) : null;
    const state = {
      mode: text(mode, 16) ?? "n",
      tokens: Array.isArray(tokens)
        ? tokens.slice(0, 16).map(token => text(token, 16) ?? "")
        : [],
      count: Number.isSafeInteger(count) && count > 0 ? count : null,
      group: text(group, 32),
      field: field === true,
    };
    this.#states.set(browser, state);
    if (windowOf(browser)?.gBrowser?.selectedBrowser == browser) {
      this.#showState(this.#windows.get(browser.ownerDocument), state);
    }
  }

  /**
   * Show every key of the page's mode in which-key, for `<leader>?`.
   *
   * @param {Window} window
   * @param {Element} browser
   */
  showAllKeys(window, browser) {
    this.#windows
      .get(window.document)
      ?.whichKey.showAll(this.keymap, this.stateFor(browser).mode);
  }

  #showState(ui, state) {
    if (!ui) {
      return;
    }
    ui.statusline.update(state);
    const whichKey = this.plugins.get("which-key");
    if (whichKey?.loaded && LazyvimiumOptions.enabled) {
      ui.whichKey.update(state, this.keymap, whichKey.opts.delay ?? 200);
    } else {
      ui.whichKey.hide();
    }
  }

  /**
   * Zen shows the compact sidebar on its empty tab, which it selects at
   * startup when nothing else is open. In vim mode the window boots with the
   * sidebar hidden instead, until the user's first key or click hands the
   * empty tab back to Zen's usual behavior.
   *
   * @param {Window} window
   */
  #bootWithSidebarHidden(window) {
    const compact = window.gZenCompactModeManager;
    const sidebar = compact?.sidebar;
    if (!LazyvimiumOptions.enabled || !sidebar) {
      return;
    }
    const hide = () => {
      if (compact.preference && sidebar.hasAttribute("zen-has-empty-tab")) {
        sidebar.removeAttribute("zen-has-empty-tab");
      }
    };
    const observer = new window.MutationObserver(hide);
    observer.observe(sidebar, {
      attributes: true,
      attributeFilter: ["zen-has-empty-tab"],
    });
    observer.observe(window.document.documentElement, {
      attributes: true,
      attributeFilter: ["zen-compact-mode"],
    });
    const stop = event => {
      if (!event.isTrusted) {
        return;
      }
      observer.disconnect();
      for (const type of ["keydown", "mousedown"]) {
        window.removeEventListener(type, stop, true);
      }
    };
    for (const type of ["keydown", "mousedown"]) {
      window.addEventListener(type, stop, true);
    }
    hide();
  }

  /**
   * @param {Element} browser
   * @returns {object}
   */
  stateFor(browser) {
    return this.#states.get(browser) ?? NORMAL_STATE;
  }

  /**
   * @param {Window} window A browser window, after delayed startup.
   */
  onWindowReady(window) {
    this.init();
    const commands = [
      ...window.document.querySelectorAll("#zenCommandSet > command"),
    ]
      .map(command => command.id)
      .sort();
    if (commands.join() != this.#zenCommands.join()) {
      this.#zenCommands = commands;
      this.reload();
    }

    window.windowUtils.loadSheetUsingURIString(
      LAZYVIMIUM_STYLESHEET,
      window.windowUtils.AUTHOR_SHEET
    );
    this.#bootWithSidebarHidden(window);
    const ui = {
      statusline: new lazy.LazyvimiumStatusline(window),
      whichKey: new lazy.LazyvimiumWhichKey(window),
    };
    this.#windows.set(window.document, ui);
    ui.statusline.setVisible(this.#statuslineVisible);
    const refresh = () =>
      this.#showState(ui, this.stateFor(window.gBrowser.selectedBrowser));
    refresh();
    window.gBrowser.tabContainer.addEventListener("TabSelect", refresh);
    window.addEventListener(
      "keydown",
      event => {
        if (ui.whichKey.pinned) {
          ui.whichKey.hide();
        }
        this.#takeReservedKey(window, event);
      },
      true
    );
    window.addEventListener(
      "unload",
      () => {
        this.#windows.delete(window.document);
      },
      { once: true }
    );
  }

  #takeReservedKey(window, event) {
    const browser = event.target;
    if (
      !event.isTrusted ||
      !LazyvimiumOptions.enabled ||
      browser?.localName != "browser" ||
      !window.gBrowser.getTabForBrowser(browser)
    ) {
      return;
    }
    const token = LazyvimiumKeys.fromEvent(event);
    if (!RESERVED_TOKENS.has(token)) {
      return;
    }
    const state = this.stateFor(browser);
    if (state.tokens.length || (state.mode == "i" && !state.field)) {
      return;
    }
    const mapping = this.keymap.get(state.mode, token);
    if (typeof mapping?.rhs != "string") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.run(mapping.rhs, {}, { browser }).catch(e =>
      console.error(`Lazyvimium: "${mapping.rhs}" failed`, e)
    );
  }

  get #statuslineVisible() {
    return LazyvimiumOptions.enabled && LazyvimiumOptions.statusline;
  }

  #registerActor() {
    lazy.ActorManagerParent.addJSWindowActors({
      LazyvimiumKeys: {
        parent: {
          esModuleURI:
            "resource:///modules/lazyvimium/actors/LazyvimiumKeysParent.sys.mjs",
        },
        child: {
          esModuleURI:
            "resource:///modules/lazyvimium/actors/LazyvimiumKeysChild.sys.mjs",
          events: {
            keydown: { capture: true },
            focusin: { capture: true },
            focusout: { capture: true },
            pageshow: {},
          },
        },
        allFrames: true,
        messageManagerGroups: ["browsers"],
        // The parent checks everything a page sends: runFromKey only runs
        // mapped actions and updateState sanitizes the state.
        safeForUntrustedWebProcess: true,
        enablePreference: LazyvimiumOptions.PREF_ENABLED,
      },
    });
  }

  #publish() {
    this.#version++;
    Services.ppmm.sharedData.set(
      LAZYVIMIUM_SHARED_KEY,
      serializeConfig({
        version: this.#version,
        timeoutlen: LazyvimiumOptions.timeoutlen,
        keymap: this.keymap,
        actions: this.actions,
        plugins: this.plugins,
      })
    );
    Services.ppmm.sharedData.flush();
  }
}

export const Lazyvimium = new LazyvimiumService();
