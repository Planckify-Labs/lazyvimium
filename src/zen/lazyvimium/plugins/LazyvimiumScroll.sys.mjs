// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const CONTENT =
  "resource:///modules/lazyvimium/plugins/LazyvimiumScrollContent.sys.mjs";

function scroll(desc, counted = true) {
  return {
    desc,
    where: "content",
    module: CONTENT,
    params: counted ? { count: "number?" } : {},
    agent: "act",
  };
}

export const LazyvimiumScrollSpec = {
  name: "scroll",
  opts: {
    step: 60,
    smooth: true,
  },
  actions: {
    "scroll.down": scroll("Scroll Down"),
    "scroll.up": scroll("Scroll Up"),
    "scroll.left": scroll("Scroll Left"),
    "scroll.right": scroll("Scroll Right"),
    "scroll.halfPageDown": scroll("Scroll Half Page Down"),
    "scroll.halfPageUp": scroll("Scroll Half Page Up"),
    "scroll.pageDown": scroll("Scroll Page Down"),
    "scroll.pageUp": scroll("Scroll Page Up"),
    "scroll.top": scroll("Go to Top", false),
    "scroll.bottom": scroll("Go to Bottom", false),
  },
};
