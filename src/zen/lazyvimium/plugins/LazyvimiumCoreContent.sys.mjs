// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { LazyvimiumDom } from "resource:///modules/lazyvimium/core/LazyvimiumDom.sys.mjs";

export const actions = {
  "mode.normal": function ({ actor, document }) {
    const active = LazyvimiumDom.deepActiveElement(document);
    if (LazyvimiumDom.isEditable(active)) {
      active.blur();
    }
    actor.setMode("n");
  },

  "mode.insert": function ({ actor }) {
    actor.setMode("i", { explicit: true });
  },
};
