// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// The vim mode switch: lazyvimium's Neovim-style keys, on or off at any
// time, as the onboarding offers them. It sits in the top bar with Zen's
// multiple toolbars. With Zen's single toolbar the row above the sidebar is
// full (148px, its reload button already overflows), so the switch goes to
// the row below the sidebar instead, before the + button. A toolbar widget,
// so it can be moved or removed like any other; where the user puts it is
// left alone.

import { LazyvimiumOptions } from "resource:///modules/lazyvimium/config/LazyvimiumOptions.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
});

const HTML_NS = "http://www.w3.org/1999/xhtml";
const WIDGET_ID = "lazyvimium-vim-mode-button";
const LABEL = "vim mode";
const PREF_SINGLE_TOOLBAR = "zen.view.use-single-toolbar";
const FOOT_AREA = "zen-sidebar-foot-buttons";
// The foot row's + button, which the switch goes before.
const CREATE_BUTTON = "zen-create-new-button";

let gRegistered = false;

// Where the switch belongs in the current layout.
function homeArea() {
  return Services.prefs.getBoolPref(PREF_SINGLE_TOOLBAR, true)
    ? FOOT_AREA
    : lazy.CustomizableUI.AREA_NAVBAR;
}

// Put the switch in its home area: next to + in the foot row, at the end of
// the top bar.
function moveHome() {
  const area = homeArea();
  const placements = lazy.CustomizableUI.getWidgetIdsInArea(area).filter(
    id => id != WIDGET_ID
  );
  const create = placements.indexOf(CREATE_BUTTON);
  lazy.CustomizableUI.addWidgetToArea(
    WIDGET_ID,
    area,
    area == FOOT_AREA && create != -1 ? create : undefined
  );
}

function tooltip(enabled) {
  return enabled
    ? "Vim mode is on: Neovim-style keys drive the browser. Click to turn it off."
    : "Vim mode is off. Click to drive the browser with Neovim-style keys.";
}

export const LazyvimiumVimModeSwitch = {
  WIDGET_ID,

  /**
   * Add the widget, once per session, where the layout has room for it.
   */
  register() {
    if (gRegistered) {
      return;
    }
    gRegistered = true;
    const placedBefore = !!lazy.CustomizableUI.getPlacementOfWidget(WIDGET_ID);
    lazy.CustomizableUI.createWidget({
      id: WIDGET_ID,
      type: "custom",
      label: LABEL,
      tooltiptext: tooltip(LazyvimiumOptions.enabled),
      defaultArea: homeArea(),
      // Kept in sight rather than in an overflow menu.
      overflows: false,
      onBuild(document) {
        const item = document.createXULElement("toolbaritem");
        item.id = WIDGET_ID;
        item.className = "chromeclass-toolbar-additional";
        item.setAttribute("label", LABEL);
        item.setAttribute("removable", "true");
        // A custom widget's node carries this itself.
        item.setAttribute("overflows", "false");

        const button = document.createElementNS(HTML_NS, "button");
        button.className = "lazyvimium-vim-mode";
        button.setAttribute("role", "switch");
        const label = document.createElementNS(HTML_NS, "span");
        label.className = "lazyvimium-vim-mode-label";
        label.textContent = LABEL;
        const track = document.createElementNS(HTML_NS, "span");
        track.className = "lazyvimium-vim-mode-track";
        track.append(document.createElementNS(HTML_NS, "span"));
        button.append(label, track);
        button.addEventListener("click", () => {
          Services.prefs.setBoolPref(
            LazyvimiumOptions.PREF_ENABLED,
            !LazyvimiumOptions.enabled
          );
        });
        item.append(button);
        LazyvimiumVimModeSwitch.syncNode(item);
        return item;
      },
    });
    // A new widget lands at the end of its area; in the foot row it belongs
    // before +.
    if (!placedBefore) {
      moveHome();
    }
    // Zen's layout can change while the browser runs. The switch follows it
    // from one home to the other, but stays wherever the user moved it.
    Services.prefs.addObserver(PREF_SINGLE_TOOLBAR, () => {
      const area = lazy.CustomizableUI.getPlacementOfWidget(WIDGET_ID)?.area;
      const homes = [FOOT_AREA, lazy.CustomizableUI.AREA_NAVBAR];
      if (homes.includes(area) && area != homeArea()) {
        moveHome();
      }
    });
  },

  /**
   * Show the current state in a window's switch, if it has one.
   *
   * @param {Document} document
   */
  sync(document) {
    const item = document.getElementById(WIDGET_ID);
    if (item) {
      this.syncNode(item);
    }
  },

  syncNode(item) {
    const enabled = LazyvimiumOptions.enabled;
    const button = item.querySelector(".lazyvimium-vim-mode");
    button?.setAttribute("aria-checked", String(enabled));
    item.toggleAttribute("checked", enabled);
    item.setAttribute("tooltiptext", tooltip(enabled));
  },
};
