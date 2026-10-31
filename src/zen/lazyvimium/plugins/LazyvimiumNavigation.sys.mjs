// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// History works like vim's jumplist: <C-o> back, <C-i> forward.

/**
 * @param {Window} window
 * @param {{trim?: boolean}} [options]
 * @returns {string} The clipboard's text.
 */
export function readClipboard(window, { trim = true } = {}) {
  const transferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(
    Ci.nsITransferable
  );
  transferable.init(window.docShell.QueryInterface(Ci.nsILoadContext));
  transferable.addDataFlavor("text/plain");
  Services.clipboard.getData(transferable, Services.clipboard.kGlobalClipboard);
  const data = {};
  try {
    transferable.getTransferData("text/plain", data);
  } catch {
    return "";
  }
  const text = data.value?.QueryInterface(Ci.nsISupportsString).data ?? "";
  return trim ? text.trim() : text;
}

/**
 * Turn clipboard text into a URL to open: a URL as is, anything else as a
 * web search. Clipboard content is untrusted, so only web URLs pass.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function urlFromClipboardText(text) {
  if (!text || text.includes("\n")) {
    return null;
  }
  let uri;
  try {
    uri = Services.uriFixup.getFixupURIInfo(
      text,
      Ci.nsIURIFixup.FIXUP_FLAG_FIX_SCHEME_TYPOS |
        Ci.nsIURIFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP
    ).preferredURI;
  } catch {
    return null;
  }
  return uri?.schemeIs("http") || uri?.schemeIs("https") ? uri.spec : null;
}

function openClipboard(window, where) {
  const url = urlFromClipboardText(readClipboard(window));
  if (url) {
    window.openTrustedLinkIn(url, where);
  }
}

export const LazyvimiumNavigationSpec = {
  name: "navigation",
  actions: {
    "history.back": {
      desc: "Go Back",
      params: { count: "number?" },
      agent: "act",
      run({ browser }, { count = 1 }) {
        const history = browser.browsingContext?.sessionHistory;
        if (count > 1 && history) {
          browser.gotoIndex(Math.max(0, history.index - count));
        } else if (browser.canGoBack) {
          browser.goBack();
        }
      },
    },
    "history.forward": {
      desc: "Go Forward",
      params: { count: "number?" },
      agent: "act",
      run({ browser }, { count = 1 }) {
        const history = browser.browsingContext?.sessionHistory;
        if (count > 1 && history) {
          browser.gotoIndex(Math.min(history.count - 1, history.index + count));
        } else if (browser.canGoForward) {
          browser.goForward();
        }
      },
    },
    "page.reload": {
      desc: "Reload Page",
      agent: "act",
      run: ({ window }) => window.BrowserCommands.reload(),
    },
    "page.hardReload": {
      desc: "Reload Page Without Cache",
      agent: "act",
      run: ({ window }) => window.BrowserCommands.reloadSkipCache(),
    },
    "url.up": {
      desc: "Open Parent Path",
      agent: "act",
      run({ browser }) {
        const uri = browser.currentURI;
        if (!uri?.schemeIs("http") && !uri?.schemeIs("https")) {
          return;
        }
        const url = new URL(uri.spec);
        url.search = "";
        url.hash = "";
        const path = url.pathname.replace(/\/+$/, "");
        if (!path) {
          return;
        }
        url.pathname = path.slice(0, path.lastIndexOf("/") + 1);
        browser.fixupAndLoadURIString(url.href, {
          triggeringPrincipal:
            Services.scriptSecurityManager.getSystemPrincipal(),
        });
      },
    },
    "url.paste": {
      desc: "Open Clipboard URL",
      agent: false,
      run: ({ window }) => openClipboard(window, "current"),
    },
    "url.pasteNewTab": {
      desc: "Open Clipboard URL in New Tab",
      agent: false,
      run: ({ window }) => openClipboard(window, "tab"),
    },
  },
};
