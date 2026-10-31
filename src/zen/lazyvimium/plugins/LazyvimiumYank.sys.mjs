// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// The yank ring: everything copied is kept in a ring that
// <leader>p lists, that survives restarts, and that <A-p> and <A-n> cycle
// through in a field right after a put.

import { LazyvimiumYankRing } from "resource:///modules/lazyvimium/core/LazyvimiumYankRing.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
  LazyvimiumPicker:
    "resource:///modules/lazyvimium/ui/LazyvimiumPicker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  readClipboard:
    "resource:///modules/lazyvimium/plugins/LazyvimiumNavigation.sys.mjs",
});

const CONTENT =
  "resource:///modules/lazyvimium/plugins/LazyvimiumYankContent.sys.mjs";
const FILE_NAME = "lazyvimium-yank.json";
const MAX_LABEL = 100;

const text = (value, max) =>
  typeof value == "string" ? value.slice(0, max) : undefined;

let gRing = null;

/**
 * The yank ring, loaded from the profile on first use.
 *
 * @param {object} [options]
 * @param {number} [options.length]
 * @param {boolean} [options.persist]
 * @returns {Promise<LazyvimiumYankRing>}
 */
export async function yankRing({ length = 100, persist = true } = {}) {
  if (!gRing) {
    const ring = Promise.withResolvers();
    gRing = ring.promise;
    let file = null;
    let entries = [];
    if (persist) {
      file = new lazy.JSONFile({
        path: PathUtils.join(PathUtils.profileDir, FILE_NAME),
        // Yanks can hold anything the user copied.
        saveDelayMs: 2000,
      });
      try {
        await file.load();
        entries = Array.isArray(file.data.entries) ? file.data.entries : [];
      } catch (e) {
        console.error("Lazyvimium: the yank history is unreadable", e);
      }
    }
    ring.resolve(
      new LazyvimiumYankRing({
        length,
        entries,
        onChange(changed) {
          if (file) {
            file.data.entries = changed.entries;
            file.saveSoon();
          }
        },
      })
    );
  }
  return gRing;
}

// The option object is the plugin's `opts`.
function ringFor(opts) {
  return yankRing({ length: opts?.length, persist: opts?.persist });
}

/**
 * A yank a page reported: a copy or a cut in it.
 *
 * @param {object} lazyvimium
 * @param {Element} browser
 * @param {object} data What the page sent; none of it is trusted.
 */
export async function recordYank(lazyvimium, browser, data) {
  if (lazy.PrivateBrowsingUtils.isBrowserPrivate(browser)) {
    return;
  }
  const ring = await ringFor(lazyvimium.plugins.get("yank")?.opts);
  ring.add(text(data?.text, 200_000), {
    url: text(data?.url, 2048),
    title: text(data?.title, 200),
  });
}

/**
 * @param {object} lazyvimium
 * @param {number} index
 * @returns {Promise<string|null>} The yank at an index, newest first.
 */
export async function yankAt(lazyvimium, index) {
  const ring = await ringFor(lazyvimium.plugins.get("yank")?.opts);
  return Number.isSafeInteger(index) ? (ring.at(index)?.text ?? null) : null;
}

// What was copied outside the browser joins the ring when it is used.
async function syncClipboard(window, opts) {
  const ring = await ringFor(opts);
  if (opts?.syncClipboard !== false) {
    ring.add(lazy.readClipboard(window, { trim: false }));
  }
  return ring;
}

function ago(time) {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return minutes < 1440
    ? `${Math.round(minutes / 60)}h`
    : `${Math.round(minutes / 1440)}d`;
}

function describe(entry) {
  const line =
    entry.text
      .split("\n")
      .find(each => each.trim())
      ?.trim() ?? "";
  let host = "";
  try {
    host = entry.url ? `${new URL(entry.url).host} · ` : "";
  } catch {
    // Not a URL.
  }
  return {
    label: line.length > MAX_LABEL ? `${line.slice(0, MAX_LABEL - 1)}…` : line,
    detail: `${host}${ago(entry.time)}`,
  };
}

async function history({ window, opts, runContent }) {
  const ring = await syncClipboard(window, opts);
  if (!ring.length) {
    window.gZenUIManager.showToast("lazyvimium-yank-empty-toast");
    return;
  }
  const entries = ring.entries;
  const index = await lazy.LazyvimiumPicker.open(window, {
    title: "Yank History",
    items: entries.map(describe),
  });
  if (index === null) {
    return;
  }
  // Into the field being typed in; anywhere else it is the clipboard's.
  const put = await runContent(
    { id: "yank.put" },
    { text: entries[index].text, index }
  );
  if (!put) {
    Cc["@mozilla.org/widget/clipboardhelper;1"]
      .getService(Ci.nsIClipboardHelper)
      .copyString(entries[index].text);
    window.gZenUIManager.showToast("lazyvimium-yank-copied-toast");
  }
}

async function clear({ window, opts }) {
  (await ringFor(opts)).clear();
  window.gZenUIManager.showToast("lazyvimium-yank-cleared-toast");
}

function content(desc, params = {}) {
  return { desc, where: "content", module: CONTENT, params, agent: false };
}

export const LazyvimiumYankSpec = {
  name: "yank",
  opts: {
    // How many yanks the ring keeps.
    length: 100,
    // Whether the ring is kept in the profile between sessions.
    persist: true,
    // Whether what is copied outside the browser joins the ring.
    syncClipboard: true,
  },
  actions: {
    "yank.history": {
      desc: "Yank History",
      agent: false,
      run: context => history(context),
    },
    "yank.clear": {
      desc: "Clear Yank History",
      agent: false,
      run: context => clear(context),
    },
    // Called with the yank to put, or to cycle in the field that has the
    // last put.
    "yank.put": content("Put a Yank"),
    "yank.putPrev": content("Put Previous Yank"),
    "yank.putNext": content("Put Next Yank"),
  },
};
