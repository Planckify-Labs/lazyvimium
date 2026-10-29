// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// uBlock Origin comes with lazyvimium. It is installed from AMO the first
// time the browser runs, the way an ExtensionSettings policy would, without
// marking the browser as managed: it updates from AMO, and the user may
// disable or remove it. Once removed it stays removed.

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  ExtensionParent: "resource://gre/modules/ExtensionParent.sys.mjs",
  ExtensionPermissions: "resource://gre/modules/ExtensionPermissions.sys.mjs",
});

const UBLOCK_ID = "uBlock0@raymondhill.net";
const INSTALL_URL =
  "https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi";
const PRIVATE_BROWSING_PERMS = {
  permissions: ["internal:privateBrowsingAllowed"],
  origins: [],
};
// The command that opens the popup of a Manifest V2 extension.
const UBLOCK_POPUP = "_execute_browser_action";

class LazyvimiumUblockService {
  PREF_ENABLED = "lazyvimium.ublock.enabled";
  ID = UBLOCK_ID;

  #initialized = false;
  /** @type {Promise|null} */
  #installing = null;
  // Set while this module removes uBO itself, which is not the user's doing.
  #uninstalling = false;

  /**
   * Whether lazyvimium keeps uBO installed: true until the user turns it
   * down in the onboarding or removes it.
   */
  get enabled() {
    return Services.prefs.getBoolPref(this.PREF_ENABLED, true);
  }

  init() {
    if (this.#initialized) {
      return;
    }
    this.#initialized = true;
    Services.prefs.addObserver(this.PREF_ENABLED, () => this.sync());
    lazy.AddonManager.addAddonListener({
      onUninstalled: addon => {
        if (addon.id == UBLOCK_ID && !this.#uninstalling) {
          Services.prefs.setBoolPref(this.PREF_ENABLED, false);
        }
      },
    });
    this.sync();
  }

  /**
   * @returns {Promise<object|null>} The installed add-on.
   */
  getAddon() {
    return lazy.AddonManager.getAddonByID(UBLOCK_ID);
  }

  /**
   * Keep or drop uBO, for the onboarding.
   *
   * @param {boolean} enabled
   */
  async setEnabled(enabled) {
    Services.prefs.setBoolPref(this.PREF_ENABLED, enabled);
    if (enabled) {
      await this.sync();
    } else {
      await this.#installing;
      await this.#uninstall();
    }
  }

  /**
   * Install uBO when lazyvimium keeps it and it is missing. One that fails,
   * offline say, is tried again on the next start.
   *
   * @returns {Promise}
   */
  sync() {
    if (!this.enabled) {
      return Promise.resolve();
    }
    this.#installing ??= this.#install()
      .catch(e => console.error("Lazyvimium: could not install uBO", e))
      .finally(() => {
        this.#installing = null;
      });
    return this.#installing;
  }

  async #install() {
    if (await this.getAddon()) {
      return;
    }
    const install = await lazy.AddonManager.getInstallForURL(INSTALL_URL, {
      name: "uBlock Origin",
      telemetryInfo: { source: "lazyvimium" },
    });
    install.addListener({
      onDownloadEnded() {
        if (install.addon && install.addon.id != UBLOCK_ID) {
          install.cancel();
        }
      },
    });
    const addon = await install.install();
    if (!this.enabled) {
      // Turned down while it was downloading.
      await this.#uninstall();
      return;
    }
    // Ads in private windows are blocked too.
    if (addon.incognito != "not_allowed") {
      await lazy.ExtensionPermissions.add(
        UBLOCK_ID,
        PRIVATE_BROWSING_PERMS,
        WebExtensionPolicy.getByID(UBLOCK_ID)?.extension
      );
      if (addon.isActive) {
        await addon.reload();
      }
    }
    // Zen keeps an extension's button in the extensions panel; uBO asks for
    // the toolbar.
    await WebExtensionPolicy.getByID(UBLOCK_ID)?.readyPromise;
    const widgetId = `${UBLOCK_ID.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}-browser-action`;
    if (lazy.CustomizableUI.getPlacementOfWidget(widgetId)) {
      lazy.CustomizableUI.addWidgetToArea(
        widgetId,
        lazy.CustomizableUI.AREA_ADDONS
      );
    }
  }

  async #uninstall() {
    const addon = await this.getAddon();
    if (!addon) {
      return;
    }
    this.#uninstalling = true;
    try {
      await addon.uninstall();
    } finally {
      this.#uninstalling = false;
    }
  }

  /**
   * Run one of uBO's commands, from its manifest's `commands`, as its
   * keyboard shortcut would.
   *
   * @param {string} name "launch-element-zapper", or
   *   "_execute_browser_action" to open its popup.
   * @param {Window} window
   * @returns {boolean} False when uBO is not running.
   */
  command(name, window) {
    const extension = WebExtensionPolicy.getByID(UBLOCK_ID)?.extension;
    if (!extension) {
      return false;
    }
    if (name == UBLOCK_POPUP) {
      lazy.ExtensionParent.apiManager.global
        .browserActionFor(extension)
        .triggerAction(window);
    } else {
      extension.shortcuts.onCommand(name);
    }
    return true;
  }
}

export const LazyvimiumUblock = new LazyvimiumUblockService();
