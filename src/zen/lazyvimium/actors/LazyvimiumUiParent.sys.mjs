// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// What a page in the panel asks for goes to the panel that shows it, which
// checks it again: the page runs in a web content process.

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Lazyvimium: "resource:///modules/lazyvimium/Lazyvimium.sys.mjs",
});

export class LazyvimiumUiParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    const browser = this.browsingContext.top.embedderElement;
    const window = browser?.documentGlobal;
    const dock = window && lazy.Lazyvimium.agentDockFor(window);
    if (!dock) {
      return "the panel is gone.";
    }
    return dock.uiRequest(browser, name.replace(/^LazyvimiumUi:/, ""), data);
  }
}
