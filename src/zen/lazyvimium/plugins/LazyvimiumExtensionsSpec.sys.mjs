// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Every extension is reached the same way, whichever it is: <leader>x lists
// the installed ones, and the one picked opens its popup, whose controls get
// jump labels (LazyvimiumPopupChild) as the sidebar's rows do for <leader>bj.

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  ExtensionParent: "resource://gre/modules/ExtensionParent.sys.mjs",
  LazyvimiumPicker:
    "resource:///modules/lazyvimium/ui/LazyvimiumPicker.sys.mjs",
});

/**
 * The running extensions the user installed that have a popup.
 *
 * @returns {Promise<{addon: object, extension: object}[]>}
 */
async function installed() {
  const { addons } = await lazy.AddonManager.getActiveAddons(["extension"]);
  return addons
    .filter(addon => !addon.isSystem && !addon.hidden)
    .flatMap(addon => {
      const extension = WebExtensionPolicy.getByID(addon.id)?.extension;
      const { manifest } = extension ?? {};
      return manifest?.browser_action || manifest?.action
        ? [{ addon, extension }]
        : [];
    })
    .sort((a, b) => a.addon.name.localeCompare(b.addon.name));
}

async function pick(window) {
  const list = await installed();
  if (!list.length) {
    window.gZenUIManager.showToast("lazyvimium-extensions-none-toast");
    return;
  }
  const index = await lazy.LazyvimiumPicker.open(window, {
    title: "Extensions",
    items: list.map(({ addon }) => ({
      label: addon.name,
      icon: addon.iconURL || undefined,
    })),
  });
  if (index !== null) {
    lazy.ExtensionParent.apiManager.global
      .browserActionFor(list[index].extension)
      .triggerAction(window);
  }
}

export const LazyvimiumExtensionsSpec = {
  name: "extensions",
  actions: {
    "extensions.pick": {
      desc: "Extensions",
      agent: false,
      run: ({ window }) => pick(window),
    },
  },
};
