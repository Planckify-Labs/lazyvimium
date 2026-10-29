// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// The top bar as a row of items, like the explorer's rows: <leader>m puts a
// cursor on its main menu button, h and l move it, <CR> presses.

const counted = { count: "number?" };

function toolbarOf({ lazyvimium, window }) {
  return lazyvimium.toolbarFor(window);
}

// An action that only does something while the toolbar mode is on.
function inToolbar(desc, run, definition = {}) {
  return {
    desc,
    agent: false,
    ...definition,
    run(context, args) {
      const toolbar = toolbarOf(context);
      return toolbar?.isOpen ? run(toolbar, context, args) : undefined;
    },
  };
}

export const LazyvimiumToolbarSpec = {
  name: "toolbar",
  actions: {
    "toolbar.open": {
      desc: "Toolbar and Main Menu",
      agent: false,
      run(context) {
        const toolbar = toolbarOf(context);
        if (toolbar?.isOpen) {
          toolbar.close();
        } else {
          toolbar?.open({ at: context.window.PanelUI?.menuButton });
        }
      },
    },
    "toolbar.quit": inToolbar("Close Toolbar", toolbar => toolbar.close()),
    "toolbar.left": inToolbar(
      "Left",
      (toolbar, context, { count = 1 }) => toolbar.move(-count),
      { params: counted }
    ),
    "toolbar.right": inToolbar(
      "Right",
      (toolbar, context, { count = 1 }) => toolbar.move(count),
      { params: counted }
    ),
    "toolbar.first": inToolbar("First Item", toolbar => toolbar.moveTo(0)),
    "toolbar.last": inToolbar("Last Item", toolbar => toolbar.moveTo(-1)),
    "toolbar.press": inToolbar("Press", toolbar => toolbar.activate()),
    "toolbar.menu": inToolbar("Menu", toolbar => toolbar.openMenu()),
    "toolbar.jump": inToolbar("Jump", toolbar => toolbar.jump()),
    "toolbar.urlbar": inToolbar("Edit Address", (toolbar, { window }) => {
      toolbar.close();
      window.gURLBar.select();
    }),
  },
};
