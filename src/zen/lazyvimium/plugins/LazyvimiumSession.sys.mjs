// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore:
    "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
});

export const LazyvimiumSessionSpec = {
  name: "session",
  actions: {
    "session.quit": {
      desc: "Quit",
      agent: false,
      run: ({ window }) => window.goQuitApplication({}),
    },
    "session.restore": {
      desc: "Restore Last Session",
      agent: "act",
      run() {
        if (lazy.SessionStore.canRestoreLastSession) {
          lazy.SessionStore.restoreLastSession();
        }
      },
    },
  },
};
