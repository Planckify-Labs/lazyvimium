// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Lazyvimium: "resource:///modules/lazyvimium/Lazyvimium.sys.mjs",
  recordYank: "resource:///modules/lazyvimium/plugins/LazyvimiumYank.sys.mjs",
  yankAt: "resource:///modules/lazyvimium/plugins/LazyvimiumYank.sys.mjs",
});

// What a frame may ask of another frame of its page, and which content
// actions it may start in it.
const FRAME_QUERIES = new Set([
  "Lazyvimium:CollectControls",
  "Lazyvimium:PressControl",
  "Lazyvimium:RunContent",
]);
const FRAME_ACTIONS = new Set(["jump.controls", "jump.hints"]);

export class LazyvimiumKeysParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    const browser = this.browsingContext.top.embedderElement;
    if (!browser) {
      return undefined;
    }
    switch (name) {
      case "Lazyvimium:Run":
        return lazy.Lazyvimium.runFromKey(browser, data.id, data.args);
      case "Lazyvimium:State":
        lazy.Lazyvimium.updateState(browser, data);
        break;
      case "Lazyvimium:Yank":
        return lazy.recordYank(lazy.Lazyvimium, browser, data);
      case "Lazyvimium:YankAt":
        return lazy.yankAt(lazy.Lazyvimium, data.index);
      case "Lazyvimium:FrameQuery":
        return this.#askFrame(data);
    }
    return undefined;
  }

  // Pass a query to another frame of this page, which a page's frames may
  // do for each other; the data is a page's, so it is checked.
  #askFrame({ bcId, name, data } = {}) {
    const frame = Number.isSafeInteger(bcId) ? BrowsingContext.get(bcId) : null;
    if (
      !frame ||
      frame.top !== this.browsingContext.top ||
      !FRAME_QUERIES.has(name) ||
      (name == "Lazyvimium:RunContent" &&
        (!FRAME_ACTIONS.has(data?.id) || frame.parent))
    ) {
      return null;
    }
    return frame.currentWindowGlobal
      ?.getActor("LazyvimiumKeys")
      .sendQuery(name, data);
  }
}
