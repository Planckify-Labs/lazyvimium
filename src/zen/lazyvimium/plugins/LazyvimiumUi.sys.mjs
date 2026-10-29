// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const SCHEME_PREF = "zen.view.window.scheme";
const SCHEME_DARK = 0;
const SCHEME_LIGHT = 1;

export const LazyvimiumUiSpec = {
  name: "ui",
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
    "ui.appMenu": {
      desc: "Main Menu",
      agent: false,
      run: ({ window }) => window.PanelUI.show(),
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
