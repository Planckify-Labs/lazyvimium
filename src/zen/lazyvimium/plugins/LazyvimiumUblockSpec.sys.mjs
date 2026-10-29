// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// uBlock Origin's own commands, from its manifest, as actions.

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  LazyvimiumUblock:
    "resource:///modules/lazyvimium/ublock/LazyvimiumUblock.sys.mjs",
});

// [action, uBO command, desc, agent access]
const COMMANDS = [
  ["ublock.popup", "_execute_browser_action", "uBlock Origin", false],
  ["ublock.zapper", "launch-element-zapper", "Element Zapper", false],
  ["ublock.picker", "launch-element-picker", "Element Picker", false],
  ["ublock.logger", "launch-logger", "Logger", false],
  ["ublock.dashboard", "open-dashboard", "Dashboard", false],
  ["ublock.relax", "relax-blocking-mode", "Relax Blocking Mode", "confirm"],
  [
    "ublock.toggleCosmetic",
    "toggle-cosmetic-filtering",
    "Toggle Cosmetic Filtering",
    "confirm",
  ],
  [
    "ublock.toggleJavascript",
    "toggle-javascript",
    "Toggle JavaScript",
    "confirm",
  ],
];

export const LazyvimiumUblockSpec = {
  name: "ublock",
  actions: Object.fromEntries(
    COMMANDS.map(([id, command, desc, agent]) => [
      id,
      {
        desc,
        agent,
        run({ window }) {
          if (!lazy.LazyvimiumUblock.command(command, window)) {
            window.gZenUIManager.showToast("lazyvimium-ublock-missing-toast");
          }
        },
      },
    ])
  ),
};
