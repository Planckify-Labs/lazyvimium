// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// The agent's tables and pages in the panel (agent/LazyvimiumAgentUi).
// A table is drawn here from its data, so it needs no sandbox: sorting,
// filtering, copying and opening its rows are the panel's own, and an
// update from the agent keeps the user's sort and filter. A page runs in a
// content <browser> of its own, in a web content process, as the sandboxed
// frame of a shell document (LazyvimiumAgentUi); while the agent still
// writes it, it shows what of its html has arrived, with nothing run.

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  LazyvimiumTheme: "resource:///modules/lazyvimium/ui/LazyvimiumTheme.sys.mjs",
  UI_SANDBOX_FLAGS:
    "resource:///modules/lazyvimium/agent/LazyvimiumAgentUi.sys.mjs",
  MAX_PAGE_HEIGHT:
    "resource:///modules/lazyvimium/agent/LazyvimiumAgentUi.sys.mjs",
  MIN_PAGE_HEIGHT:
    "resource:///modules/lazyvimium/agent/LazyvimiumAgentUi.sys.mjs",
  dataAddress: "resource:///modules/lazyvimium/agent/LazyvimiumAgentUi.sys.mjs",
  findTab: "resource:///modules/lazyvimium/agent/LazyvimiumAgentTools.sys.mjs",
  isEmptyCell: "resource:///modules/lazyvimium/agent/LazyvimiumAgentUi.sys.mjs",
  isNumberColumn:
    "resource:///modules/lazyvimium/agent/LazyvimiumAgentUi.sys.mjs",
  numberOf: "resource:///modules/lazyvimium/agent/LazyvimiumAgentUi.sys.mjs",
  pageDocument:
    "resource:///modules/lazyvimium/agent/LazyvimiumAgentUi.sys.mjs",
  partialHtml: "resource:///modules/lazyvimium/agent/LazyvimiumAgentUi.sys.mjs",
  toCsv: "resource:///modules/lazyvimium/agent/LazyvimiumAgentUi.sys.mjs",
});

const HTML_NS = "http://www.w3.org/1999/xhtml";
// A table this long gets a filter box.
const FILTER_FROM_ROWS = 6;
const COPIED_MS = 1500;

export class LazyvimiumAgentUiView {
  #window;
  #onPrompt;
  // Each message's parts and what the user did with them.
  #states = new WeakMap();
  // Each page's browser, to its message.
  #pages = new WeakMap();

  /**
   * @param {Window} window
   * @param {object} options
   * @param {(text: string) => true|string} options.onPrompt Ask the agent
   *   something for a page; returns true, or why it could not.
   */
  constructor(window, { onPrompt }) {
    this.#window = window;
    this.#onPrompt = onPrompt;
  }

  /**
   * Draw a ui message in its row, which is kept across its updates.
   *
   * @param {Element} row
   * @param {object} message
   */
  update(row, message) {
    row.classList.add("lazyvimium-agent-ui");
    row.setAttribute("kind", message.ui.kind);
    row.toggleAttribute("draft", message.status == "draft");
    if (message.ui.kind == "table") {
      this.#table(row, message);
    } else {
      this.#page(row, message);
    }
  }

  /**
   * Load the pages whose browsers have nothing, or something older, after
   * the rows went into the panel: a browser put back after its conversation
   * was away starts empty.
   *
   * @param {Element} log
   */
  attach(log) {
    for (const browser of log.querySelectorAll(".lazyvimium-ui-browser")) {
      const message = this.#pages.get(browser);
      if (message) {
        this.#load(browser, message);
      }
    }
  }

  /**
   * A request from a page, already checked by its child actor; checked
   * again here.
   *
   * @param {Element} browser
   * @param {string} name Height, Prompt, OpenLink or FocusTab.
   * @param {object} data
   * @returns {true|string} true, or why not.
   */
  request(browser, name, data) {
    const message = this.#pages.get(browser);
    if (!message || !browser.isConnected) {
      return "the page is no longer in the panel.";
    }
    switch (name) {
      case "Height": {
        const height = Number(data?.height);
        if (Number.isFinite(height)) {
          const state = this.#state(message);
          // The page's own height wins over the agent's estimate.
          state.measured = true;
          state.height = Math.round(
            Math.min(
              lazy.MAX_PAGE_HEIGHT,
              Math.max(lazy.MIN_PAGE_HEIGHT, height)
            )
          );
          browser.style.height = `${state.height}px`;
        }
        return true;
      }
      case "Prompt": {
        const text = String(data?.text ?? "").trim();
        return text ? this.#onPrompt(text.slice(0, 4000)) : "nothing to ask.";
      }
      case "OpenLink":
        return this.#openLink(data?.url);
      case "FocusTab":
        return this.#focusTab(data?.tab);
    }
    return `unknown request ${name}.`;
  }

  #state(message) {
    let state = this.#states.get(message);
    if (!state) {
      state = { sort: null, filter: "", keys: null };
      this.#states.set(message, state);
    }
    return state;
  }

  #create(tag, className, text) {
    const element = this.#window.document.createElementNS(HTML_NS, tag);
    if (className) {
      element.className = className;
    }
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  }

  #openLink(url) {
    try {
      const parsed = new URL(String(url ?? ""));
      if (parsed.protocol != "https:" && parsed.protocol != "http:") {
        return "only http(s) addresses open.";
      }
      this.#window.openWebLinkIn(parsed.href, "tab", {
        relatedToCurrent: true,
      });
      return true;
    } catch {
      return "not an address.";
    }
  }

  #focusTab(id) {
    const tab = lazy.findTab(this.#window, String(id ?? ""));
    if (!tab) {
      return `there is no tab ${id}.`;
    }
    this.#window.gBrowser.selectedTab = tab;
    return true;
  }

  // Tables.

  #table(row, message) {
    const state = this.#state(message);
    if (!state.parts) {
      const head = this.#create("div", "lazyvimium-ui-head");
      const title = this.#create("span", "lazyvimium-ui-title");
      const count = this.#create("span", "lazyvimium-ui-count");
      const filter = this.#create("input", "lazyvimium-ui-filter");
      filter.type = "search";
      filter.placeholder = "Filter";
      filter.setAttribute("aria-label", "Filter the rows");
      filter.addEventListener("input", () => {
        state.filter = filter.value;
        this.#fillTable(message);
      });
      const copy = this.#create("button", "lazyvimium-ui-button", "Copy CSV");
      copy.type = "button";
      copy.addEventListener("click", () => this.#copy(message, copy));
      head.append(title, count, filter, copy);
      const scroller = this.#create("div", "lazyvimium-ui-scroll");
      const table = this.#create("table", "lazyvimium-ui-table");
      const thead = this.#create("thead");
      const tbody = this.#create("tbody");
      table.append(thead, tbody);
      scroller.append(table);
      const note = this.#create("p", "lazyvimium-ui-note");
      row.replaceChildren(head, scroller, note);
      state.parts = { title, count, filter, thead, tbody, note };
    }
    const { rows } = message.ui;
    const previous = state.keys;
    state.keys = new Set(rows.map(r => r.cells.join("\u0000")));
    // Rows an update added, to show them.
    state.fresh = previous
      ? new Set([...state.keys].filter(key => !previous.has(key)))
      : new Set();
    this.#fillTable(message);
  }

  // The rows the filter keeps, in the order the sort asks for; cells that
  // say nothing go last either way.
  #visibleRows(table, state) {
    const needle = state.filter.trim().toLowerCase();
    let rows = table.rows.filter(
      row =>
        !needle || row.cells.some(cell => cell.toLowerCase().includes(needle))
    );
    const sort = state.sort;
    if (sort && sort.column < table.columns.length) {
      const numeric = lazy.isNumberColumn(table, sort.column);
      const sign = sort.descending ? -1 : 1;
      rows = rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => {
          const x = a.row.cells[sort.column];
          const y = b.row.cells[sort.column];
          const emptyX = lazy.isEmptyCell(x);
          const emptyY = lazy.isEmptyCell(y);
          if (emptyX || emptyY) {
            return emptyX - emptyY || a.index - b.index;
          }
          const order = numeric
            ? lazy.numberOf(x) - lazy.numberOf(y)
            : x.localeCompare(y, undefined, { numeric: true });
          return sign * order || a.index - b.index;
        })
        .map(({ row }) => row);
    }
    return rows;
  }

  #fillTable(message) {
    const table = message.ui;
    const state = this.#state(message);
    const { title, count, filter, thead, tbody, note } = state.parts;
    title.textContent = table.title;
    const rows = this.#visibleRows(table, state);
    const total = table.rows.length;
    count.textContent =
      rows.length == total
        ? `${total} ${total == 1 ? "row" : "rows"}`
        : `${rows.length} of ${total}`;
    filter.hidden = total < FILTER_FROM_ROWS && !state.filter;
    note.textContent = table.note;
    note.hidden = !table.note;

    const numeric = table.columns.map((_, i) => lazy.isNumberColumn(table, i));
    // The header is built again only for other columns, so a sort button
    // keeps the focus it was clicked with.
    const columnsKey = table.columns.join("\u0000");
    if (state.columnsKey != columnsKey) {
      state.columnsKey = columnsKey;
      const headRow = this.#create("tr");
      table.columns.forEach((name, column) => {
        const th = this.#create("th");
        const button = this.#create("button", "lazyvimium-ui-sort", name);
        button.type = "button";
        button.title = `Sort by ${name}`;
        button.addEventListener("click", () => {
          // Ascending, then descending, then as the agent sent it.
          if (state.sort?.column != column) {
            state.sort = { column, descending: false };
          } else if (!state.sort.descending) {
            state.sort = { column, descending: true };
          } else {
            state.sort = null;
          }
          this.#fillTable(message);
        });
        th.append(button);
        headRow.append(th);
      });
      thead.replaceChildren(headRow);
    }
    [...thead.querySelectorAll("th")].forEach((th, column) => {
      th.toggleAttribute("numeric", numeric[column]);
      let sort = "none";
      if (state.sort?.column == column) {
        sort = state.sort.descending ? "descending" : "ascending";
      }
      th.setAttribute("aria-sort", sort);
    });

    tbody.replaceChildren(
      ...rows.map(row => {
        const tr = this.#create("tr");
        row.cells.forEach((cell, column) => {
          const td = this.#create("td", "", cell);
          td.toggleAttribute("numeric", numeric[column]);
          tr.append(td);
        });
        if (state.fresh?.has(row.cells.join("\u0000"))) {
          tr.setAttribute("fresh", "");
        }
        if (row.tab || row.url) {
          tr.setAttribute("link", "");
          tr.tabIndex = 0;
          tr.title = row.tab ? `Show tab ${row.tab}` : row.url;
          const open = () => {
            if (row.tab && this.#focusTab(row.tab) === true) {
              return;
            }
            if (row.url) {
              this.#openLink(row.url);
            }
          };
          tr.addEventListener("click", open);
          tr.addEventListener("keydown", event => {
            if (event.key == "Enter") {
              open();
            }
          });
        }
        return tr;
      })
    );
  }

  #copy(message, button) {
    const table = message.ui;
    const rows = this.#visibleRows(table, this.#state(message));
    Cc["@mozilla.org/widget/clipboardhelper;1"]
      .getService(Ci.nsIClipboardHelper)
      .copyString(
        lazy.toCsv(
          table.columns,
          rows.map(row => row.cells)
        )
      );
    button.textContent = "Copied";
    this.#window.setTimeout(() => {
      button.textContent = "Copy CSV";
    }, COPIED_MS);
  }

  // Pages.

  #page(row, message) {
    const page = message.ui;
    const state = this.#state(message);
    if (!state.parts) {
      const head = this.#create("div", "lazyvimium-ui-head");
      const title = this.#create("span", "lazyvimium-ui-title");
      const status = this.#create("span", "lazyvimium-ui-count");
      head.append(title, status);
      const placeholder = this.#create(
        "div",
        "lazyvimium-ui-placeholder",
        "Building…"
      );
      const browser = this.#createBrowser();
      state.height = page.height;
      row.replaceChildren(head, placeholder, browser);
      this.#pages.set(browser, message);
      state.parts = { title, status, placeholder, browser };
    }
    const { title, status, placeholder, browser } = state.parts;
    const draft = message.status == "draft";
    title.textContent = page.title || "Building a page";
    status.textContent = draft ? "building…" : "";
    // Until the css is done there is nothing to show but a placeholder.
    const showing = !!page.html;
    placeholder.hidden = showing;
    if (!draft && page.height && !state.measured) {
      state.height = page.height;
    }
    browser.style.height = showing ? `${state.height}px` : "0";
    browser.toggleAttribute("collapsed-page", !showing);
    if (browser.isConnected) {
      this.#load(browser, message);
    }
  }

  #createBrowser() {
    const browser = this.#window.document.createXULElement("browser");
    for (const [name, value] of Object.entries({
      type: "content",
      remote: "true",
      // A process of its own kind, kept: the page's browsing context and
      // its sandbox flags stay as they are.
      remoteType: "web",
      messagemanagergroup: "lazyvimium-ui",
      disableglobalhistory: "true",
      disablehistory: "true",
      nodefaultsrc: "true",
    })) {
      browser.setAttribute(name, value);
    }
    browser.className = "lazyvimium-ui-browser";
    return browser;
  }

  // Show what the message has in its browser: the finished page, or the
  // draft's html so far.
  #load(browser, message) {
    const page = message.ui;
    if (!page.html) {
      return;
    }
    const state = this.#state(message);
    const context = browser.browsingContext;
    if (!context) {
      return;
    }
    const draft = message.status == "draft";
    // A draft's document changes only when its css does; its html goes in
    // as it arrives.
    const wanted = draft
      ? `draft\u0000${page.css}`
      : `page\u0000${message.revision}`;
    if (state.context != context || state.loaded != wanted) {
      context.sandboxFlags = lazy.UI_SANDBOX_FLAGS;
      const html = lazy.pageDocument(page, lazy.LazyvimiumTheme.variables(), {
        preview: draft,
      });
      state.address = lazy.dataAddress(html);
      state.context = context;
      state.loaded = wanted;
      state.preview = draft ? page.html : null;
      browser.loadURI(Services.io.newURI(state.address), {
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
      });
      return;
    }
    if (draft && state.preview != page.html) {
      // Only once the preview shell and its frame are in: until then, the
      // next update brings the html.
      const frame = context.children[0]?.currentWindowGlobal;
      if (
        context.currentWindowGlobal?.documentURI?.spec == state.address &&
        frame?.documentURI?.spec == "about:srcdoc"
      ) {
        state.preview = page.html;
        frame
          .getActor("LazyvimiumUi")
          .sendAsyncMessage("LazyvimiumUi:Preview", {
            html: lazy.partialHtml(page.html),
          });
      }
    }
  }
}
