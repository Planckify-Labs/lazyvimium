// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Lazyvimium: "resource:///modules/lazyvimium/Lazyvimium.sys.mjs",
});

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
    }
    return undefined;
  }
}
