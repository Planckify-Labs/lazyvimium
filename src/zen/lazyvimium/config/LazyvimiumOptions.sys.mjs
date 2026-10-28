// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { LazyvimiumKeys } from "resource:///modules/lazyvimium/core/LazyvimiumKeys.sys.mjs";

export const LazyvimiumOptions = {
  PREF_ENABLED: "lazyvimium.enabled",
  PREF_LEADER: "lazyvimium.leader",
  PREF_TIMEOUTLEN: "lazyvimium.timeoutlen",
  PREF_STATUSLINE: "lazyvimium.statusline.enabled",

  get enabled() {
    return Services.prefs.getBoolPref(this.PREF_ENABLED, true);
  },

  get leader() {
    const leader = Services.prefs.getStringPref(
      this.PREF_LEADER,
      LazyvimiumKeys.DEFAULT_LEADER
    );
    try {
      LazyvimiumKeys.parse(leader, { leader });
      return leader;
    } catch (e) {
      console.error(`Lazyvimium: invalid ${this.PREF_LEADER} "${leader}"`, e);
      return LazyvimiumKeys.DEFAULT_LEADER;
    }
  },

  get timeoutlen() {
    return Math.max(0, Services.prefs.getIntPref(this.PREF_TIMEOUTLEN, 300));
  },

  get statusline() {
    return Services.prefs.getBoolPref(this.PREF_STATUSLINE, true);
  },
};
