// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Moving between the fields of a page. Fields are ordered as they read on
// screen: top to bottom, then left to right.

const CONTENT =
  "resource:///modules/lazyvimium/plugins/LazyvimiumInputsContent.sys.mjs";

function field(desc) {
  return {
    desc,
    where: "content",
    module: CONTENT,
    params: { count: "number?" },
    agent: "act",
  };
}

export const LazyvimiumInputsSpec = {
  name: "inputs",
  actions: {
    "input.first": field("Insert in First Visible Field"),
    "input.last": field("Insert in Last Used Field"),
    "input.next": field("Next Field"),
    "input.prev": field("Prev Field"),
  },
};
