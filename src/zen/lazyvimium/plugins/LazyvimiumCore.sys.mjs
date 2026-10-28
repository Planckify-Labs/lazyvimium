// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const CONTENT =
  "resource:///modules/lazyvimium/plugins/LazyvimiumCoreContent.sys.mjs";

export const LazyvimiumCoreSpec = {
  name: "core",
  priority: 0,
  opts: {
    // Keep pages from entering insert mode by focusing a field on load.
    preventAutofocus: true,
  },
  actions: {
    "mode.normal": { desc: "Normal Mode", where: "content", module: CONTENT },
    "mode.insert": { desc: "Insert Mode", where: "content", module: CONTENT },
  },
};
