// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// The browser tools an agent gets over MCP. The agent works on one tab at a
// time, at first the one the user asked from; the tab tools list, open,
// switch between and close the window's tabs, each known by an id like t3,
// and the page tools read and drive the tab it works on or any tab it
// names. browser_action reaches every registry action marked for agents,
// the same ones keymaps run.

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const LOAD_TIMEOUT_MS = 15000;
const RETRY_MS = 100;
// How long a click takes to start the navigation it causes, if it does.
const NAVIGATION_START_MS = 250;

function sleep(ms) {
  return new Promise(resolve => lazy.setTimeout(resolve, ms));
}

function quote(text) {
  return JSON.stringify(String(text));
}

// The ids agents know tabs by, t1, t2 and on: owned by the browser and kept
// for the tab's life, as element ids are, so an id never points at another
// tab once its own has closed.
const gTabIds = new WeakMap();
let gNextTabId = 0;

/**
 * @param {Element} tab
 * @returns {string} Its id for agents.
 */
export function tabIdOf(tab) {
  let id = gTabIds.get(tab);
  if (!id) {
    id = `t${++gNextTabId}`;
    gTabIds.set(tab, id);
  }
  return id;
}

function findTab(window, id) {
  return window.gBrowser.tabs.find(tab => gTabIds.get(tab) == id) ?? null;
}

// A tab whose page is not in memory: Zen unloaded it, or the session has
// not restored it yet.
function isUnloaded(tab) {
  return !tab.linkedPanel || tab.hasAttribute("pending");
}

/**
 * The text an agent reads for one observation, after jev's element table.
 *
 * @param {object} page What LazyvimiumAgentContent's observe() returned.
 * @param {string} [tab] The tab's id.
 * @returns {string}
 */
export function formatObservation(page, tab) {
  const lines = [
    ...(tab ? [`Tab: ${tab}`] : []),
    `Title: ${page.title || "(none)"}`,
    `URL: ${page.url}`,
    `Scroll: ${Math.round(page.scroll.y)} of ${Math.max(0, Math.round(page.scroll.height - page.scroll.viewport))}px`,
  ];
  if (page.loading) {
    lines.push("The page is still loading.");
  }
  if (page.selection) {
    lines.push(`Selected text: ${quote(page.selection)}`);
  }
  lines.push("", "Elements in view:");
  if (!page.elements.length) {
    lines.push("(none)");
  }
  for (const element of page.elements) {
    let line = `[${element.id}] ${element.role} ${quote(element.label)}`;
    if (element.value !== undefined) {
      line += ` value=${quote(element.value)}`;
    }
    for (const key of ["checked", "selected", "expanded"]) {
      if (element[key] !== undefined) {
        line += ` ${key}=${element[key]}`;
      }
    }
    if (element.editable) {
      line += " (editable)";
    }
    if (element.covered) {
      line += ` (covered by ${element.covered})`;
    }
    if (element.options) {
      line += ` options: ${element.options.map(quote).join(", ")}`;
    }
    lines.push(line);
  }
  if (page.omitted) {
    lines.push(`(${page.omitted} more not listed; scroll or act to see them)`);
  }
  lines.push("", "Visible text:", page.text || "(none)");
  return lines.join("\n");
}

/**
 * The MCP tool descriptions.
 *
 * @param {object} registry The LazyvimiumActions.
 * @returns {object[]}
 */
export function toolDefinitions(registry) {
  const browserActions = agentActions(registry);
  const tab = {
    type: "string",
    description:
      "A tab id such as t3 from tabs_list; the tab you work on if left out",
  };
  return [
    {
      name: "page_observe",
      description:
        "Read a tab: its title and URL, every control in view with an id like e12, and the visible text.",
      inputSchema: {
        type: "object",
        properties: { tab },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "page_act",
      description:
        "Act on a tab and return it afterwards. click, fill (replace a field's text), select (an option of a native list), press (a key such as Enter, Escape, Tab, ArrowDown) or scroll (up or down, or an element into view). element is an id from the tab's latest observation.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["click", "fill", "select", "press", "scroll"],
          },
          element: { type: "string", description: "An id such as e12" },
          text: {
            type: "string",
            description:
              "fill: the text. select: the option. press: the key. scroll: up or down.",
          },
          tab,
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    {
      name: "page_navigate",
      description:
        "Open an http(s) address in a tab, or in a new tab that becomes the one you work on, and return the loaded page.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          newTab: { type: "boolean" },
          tab,
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    {
      name: "tabs_list",
      description:
        "List the tabs open in the window, each with an id like t3, its title and address, which one the user has in front and which one you work on.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "tab_open",
      description:
        "Open a new tab, on an http(s) address or empty, and work on it from now on. It comes to the front unless background is true. Returns the loaded page.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          background: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "tab_switch",
      description:
        "Work on another open tab from now on and return it. It comes to the front for the user unless show is false.",
      inputSchema: {
        type: "object",
        properties: {
          tab: { type: "string", description: "A tab id such as t3" },
          show: { type: "boolean" },
        },
        required: ["tab"],
        additionalProperties: false,
      },
    },
    {
      name: "tab_close",
      description:
        "Close a tab. Closing one you did not open asks the user first.",
      inputSchema: {
        type: "object",
        properties: {
          tab: { type: "string", description: "A tab id such as t3" },
        },
        required: ["tab"],
        additionalProperties: false,
      },
      annotations: { destructiveHint: true },
    },
    {
      name: "browser_action",
      description: `Run a browser command on a tab. Some ask the user first. Commands:\n${browserActions
        .map(action => `${action.id}: ${action.desc}${paramsText(action)}`)
        .join("\n")}`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", enum: browserActions.map(action => action.id) },
          args: { type: "object" },
          tab,
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  ];
}

function paramsText(action) {
  const names = Object.entries(action.params);
  return names.length
    ? ` (args: ${names.map(([name, type]) => `${name}: ${type}`).join(", ")})`
    : "";
}

function agentActions(registry) {
  return registry
    .list({ agent: true })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * What an agent's tools work on: one conversation's tabs, in its window.
 */
export class LazyvimiumAgentToolbox {
  // The dock's title of the last step, for the log.
  #lastTitle = null;

  /**
   * @param {object} options
   * @param {object} options.lazyvimium The Lazyvimium service.
   * @param {() => Element} options.browser The browser of the tab the agent
   *   works on.
   * @param {(browser: Element) => void} options.retarget Called when the
   *   agent moves to another tab.
   * @param {(step: object) => void} options.onStep Each tool call, for the
   *   panel: {tool, title, status, detail}.
   * @param {(question: string) => Promise<boolean>} options.confirm Ask the
   *   user before an action marked "confirm", phrased to follow "Allow the
   *   agent to".
   * @param {object} [options.log] The conversation's LazyvimiumAgentLog.
   * @param {WeakSet<Element>} [options.opened] The tabs the agent opened,
   *   which it closes without asking.
   */
  constructor({
    lazyvimium,
    browser,
    retarget,
    onStep,
    confirm,
    log = null,
    opened = new WeakSet(),
  }) {
    this.lazyvimium = lazyvimium;
    this.browser = browser;
    this.retarget = retarget;
    this.onStep = onStep;
    this.confirm = confirm;
    this.log = log;
    this.opened = opened;
    this.window = browser()?.documentGlobal;
  }

  listTools() {
    return toolDefinitions(this.lazyvimium.actions);
  }

  // Every call goes in the log with the full text the agent got back: what
  // it saw is usually why it did what it did.
  async callTool(name, args) {
    const started = Date.now();
    let result;
    try {
      result = await this.#callTool(name, args);
      return result;
    } catch (e) {
      result = { text: String(e?.message ?? e), isError: true };
      throw e;
    } finally {
      this.log?.write("tool", {
        name,
        args,
        ms: Date.now() - started,
        isError: !!result?.isError,
        title: this.#lastTitle,
        url: this.browser()?.currentURI?.spec,
        tab: args?.tab,
        text: result?.text,
      });
    }
  }

  async #callTool(name, args = {}) {
    this.#lastTitle = null;
    switch (name) {
      case "page_observe":
        return this.#onTab(args.tab, "Read the page", async browser => ({
          title: args.tab ? `Read ${args.tab}` : "Read the page",
          text: await this.#observeText(browser),
        }));
      case "page_act":
        return this.#act(args);
      case "page_navigate":
        return this.#navigate(args);
      case "tabs_list":
        return this.#step("Listed the tabs", async () => this.#listTabs());
      case "tab_open":
        return this.#openTab(args);
      case "tab_switch":
        return this.#switchTab(args);
      case "tab_close":
        return this.#closeTab(args);
      case "browser_action":
        return this.#browserAction(args);
    }
    throw new Error(`Unknown tool ${name}`);
  }

  // The browser of the tab the agent works on. If that tab was closed, the
  // one in front takes its place.
  #working() {
    const browser = this.browser();
    if (
      browser?.isConnected &&
      this.window.gBrowser.getTabForBrowser(browser)
    ) {
      return browser;
    }
    const next = this.window.gBrowser.selectedBrowser;
    this.retarget(next);
    return next;
  }

  #idOf(browser) {
    return tabIdOf(this.window.gBrowser.getTabForBrowser(browser));
  }

  // Find the tab an id names, with what to tell the agent if it cannot work
  // on it.
  #resolveTab(id) {
    const tab = findTab(this.window, id);
    if (!tab) {
      return {
        error: `There is no tab ${quote(id)}. tabs_list shows the open tabs.`,
      };
    }
    return { tab };
  }

  // Run a step on the tab an id names, or the one the agent works on.
  #onTab(id, title, work) {
    return this.#step(title, async () => {
      let browser = this.#working();
      if (id) {
        const { tab, error } = this.#resolveTab(id);
        if (error) {
          return { text: error, isError: true };
        }
        if (isUnloaded(tab)) {
          return {
            text: `${id} is unloaded. tab_switch to it with show true to load it.`,
            isError: true,
          };
        }
        browser = tab.linkedBrowser;
      }
      return work(browser);
    });
  }

  #describeTab(tab, working) {
    const gBrowser = this.window.gBrowser;
    const notes = [];
    if (tab == gBrowser.selectedTab) {
      notes.push("in front");
    }
    if (tab.linkedBrowser == working) {
      notes.push("you work on it");
    }
    if (this.opened.has(tab)) {
      notes.push("you opened it");
    }
    if (tab.pinned) {
      notes.push("pinned");
    }
    if (isUnloaded(tab)) {
      notes.push("unloaded");
    } else if (tab.hasAttribute("busy")) {
      notes.push("loading");
    }
    const url = tab.linkedBrowser?.currentURI?.spec ?? "";
    return `[${tabIdOf(tab)}] ${quote(tab.label)} ${url}${notes.length ? ` (${notes.join(", ")})` : ""}`;
  }

  // The tabs of the space the user is in, and the one the agent works on
  // wherever it is.
  #listTabs() {
    const gBrowser = this.window.gBrowser;
    const working = this.#working();
    const tabs = [...gBrowser.visibleTabs];
    const workingTab = gBrowser.getTabForBrowser(working);
    if (workingTab && !tabs.includes(workingTab)) {
      tabs.push(workingTab);
    }
    return {
      title: `Listed ${tabs.length} tabs`,
      text: tabs.map(tab => this.#describeTab(tab, working)).join("\n"),
    };
  }

  #checkAddress(url) {
    let uri;
    try {
      uri = Services.io.newURI(url);
    } catch {
      return { error: `${quote(url)} is not a URL` };
    }
    if (!uri.schemeIs("http") && !uri.schemeIs("https")) {
      return { error: "Only http and https addresses open" };
    }
    return { spec: uri.spec };
  }

  #openTab({ url = "", background = false }) {
    return this.#step(
      url ? `Open ${url} in a new tab` : "Open a new tab",
      async () => {
        let spec = "about:blank";
        if (url) {
          const check = this.#checkAddress(url);
          if (check.error) {
            return { text: check.error, isError: true };
          }
          spec = check.spec;
        }
        const gBrowser = this.window.gBrowser;
        const tab = gBrowser.addTrustedTab(spec, {
          ownerTab: gBrowser.getTabForBrowser(this.#working()),
        });
        this.opened.add(tab);
        const id = tabIdOf(tab);
        // Before it comes to the front, so the panel there finds the
        // conversation.
        this.retarget(tab.linkedBrowser);
        if (!background) {
          gBrowser.selectedTab = tab;
        }
        const where = background ? "in the background" : "in front";
        if (!url) {
          return {
            title: `Opened ${id}`,
            text: `Opened the empty tab ${id} ${where}; you work on it now. page_navigate loads an address in it.`,
          };
        }
        await this.#waitForAddressChange(tab.linkedBrowser, "about:blank");
        await this.#settleNavigation(tab.linkedBrowser);
        return {
          title: `Opened ${id} on ${url}`,
          text: `Opened ${id} ${where}; you work on it now.\n\n${await this.#observeText(tab.linkedBrowser)}`,
        };
      }
    );
  }

  #switchTab({ tab: id, show = true }) {
    return this.#step(`Switch to ${id}`, async () => {
      const { tab, error } = this.#resolveTab(id);
      if (error) {
        return { text: error, isError: true };
      }
      if (!show && isUnloaded(tab)) {
        return {
          text: `${id} is unloaded; switch to it with show true to load it.`,
          isError: true,
        };
      }
      this.retarget(tab.linkedBrowser);
      if (show) {
        this.window.gBrowser.selectedTab = tab;
        await this.#settleNavigation(tab.linkedBrowser);
      }
      return {
        title: `Switched to ${id} ${quote(tab.label)}`,
        text: `You work on ${id} now.\n\n${await this.#observeText(tab.linkedBrowser)}`,
      };
    });
  }

  #closeTab({ tab: id }) {
    return this.#step(`Close ${id}`, async () => {
      const { tab, error } = this.#resolveTab(id);
      if (error) {
        return { text: error, isError: true };
      }
      const gBrowser = this.window.gBrowser;
      if (gBrowser.visibleTabs.length <= 1) {
        return {
          text: `${id} is the last tab; closing it would close the window.`,
          isError: true,
        };
      }
      const label = tab.label;
      if (
        !this.opened.has(tab) &&
        !(await this.confirm(`close the tab ${quote(label)}`))
      ) {
        return {
          title: `Close ${id} (declined)`,
          text: "The user declined closing this tab.",
          isError: true,
        };
      }
      const working = tab.linkedBrowser == this.browser();
      gBrowser.removeTab(tab, { animate: false });
      if (gBrowser.tabs.includes(tab) && !tab.closing) {
        return {
          title: `Close ${id} (kept open)`,
          text: `${id} asked to stay open, and stays.`,
          isError: true,
        };
      }
      let text = `Closed ${id} ${quote(label)}.`;
      if (working) {
        const next = this.#working();
        text += ` You work on ${this.#idOf(next)} ${quote(gBrowser.getTabForBrowser(next).label)} now.`;
      }
      return { title: `Closed ${id} ${quote(label)}`, text };
    });
  }

  // Report a tool call to the panel around its work.
  async #step(title, work) {
    const step = { title, status: "running" };
    this.onStep(step);
    try {
      const result = await work();
      step.status = result.isError ? "failed" : "done";
      step.title = result.title ?? title;
      this.#lastTitle = step.title;
      this.onStep(step);
      return { text: result.text, isError: !!result.isError };
    } catch (e) {
      step.status = "failed";
      step.detail = String(e.message ?? e);
      this.onStep(step);
      throw e;
    }
  }

  #runContent(browser, id, args = {}) {
    return this.lazyvimium.run(id, args, { browser });
  }

  // Observe, waiting out a navigation: the page's actor is gone while the
  // next document loads.
  async #observe(browser) {
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const page = await this.#runContent(browser, "agent.observe");
        if (!page.loading || Date.now() + RETRY_MS >= deadline) {
          return page;
        }
      } catch (e) {
        lastError = e;
      }
      await sleep(RETRY_MS);
    }
    throw new Error(
      `The page did not respond${lastError ? `: ${lastError.message}` : ""}`
    );
  }

  async #observeText(browser) {
    return formatObservation(await this.#observe(browser), this.#idOf(browser));
  }

  // A load to another site switches processes, and until the new document
  // commits the browser reports neither the new address nor a load: in dev
  // testing, music.youtube.com → www.youtube.com came back as the old page.
  async #waitForAddressChange(browser, before) {
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (browser.currentURI?.spec == before && Date.now() < deadline) {
      await sleep(RETRY_MS);
    }
  }

  // Wait for a navigation an action started, so the agent gets the page it
  // led to rather than the one it left. In dev testing, links answered with
  // the old page made the agent click them again.
  async #settleNavigation(browser) {
    await sleep(NAVIGATION_START_MS);
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (browser.webProgress?.isLoadingDocument && Date.now() < deadline) {
      await sleep(RETRY_MS);
    }
  }

  #act(args) {
    const { action, element, text, tab } = args;
    const title = [action, element, tab && `on ${tab}`]
      .filter(Boolean)
      .join(" ");
    return this.#onTab(tab, title, async browser => {
      let result;
      try {
        result = await this.#runContent(browser, "agent.act", {
          action,
          element,
          text,
        });
      } catch {
        // The page went away mid-action: a click that navigated.
        result = { ok: true, done: `Did ${action}; the page navigated` };
      }
      if (result.ok && (action == "click" || action == "press")) {
        await this.#settleNavigation(browser);
      }
      const observation = await this.#observeText(browser);
      if (!result.ok) {
        return {
          title,
          text: `${result.error}\n\n${observation}`,
          isError: true,
        };
      }
      return {
        title: tab ? `${result.done} on ${tab}` : result.done,
        text: `${result.done}.\n\n${observation}`,
      };
    });
  }

  #navigate({ url, newTab = false, tab }) {
    if (newTab) {
      return this.#openTab({ url });
    }
    return this.#onTab(tab, `Open ${url}`, async browser => {
      const check = this.#checkAddress(url);
      if (check.error) {
        return { text: check.error, isError: true };
      }
      const before = browser.currentURI?.spec;
      browser.fixupAndLoadURIString(check.spec, {
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
      });
      // The old document can answer before the load replaces it.
      if (before != check.spec) {
        await this.#waitForAddressChange(browser, before);
      }
      await this.#settleNavigation(browser);
      return { text: await this.#observeText(browser) };
    });
  }

  async #browserAction({ id, args = {}, tab }) {
    const action = this.lazyvimium.actions.get(id);
    if (!action || action.agent === false) {
      return { text: `There is no browser command "${id}"`, isError: true };
    }
    return this.#onTab(tab, action.desc, async browser => {
      this.lazyvimium.actions.validate(id, args);
      if (
        action.agent == "confirm" &&
        !(await this.confirm(action.desc.toLowerCase()))
      ) {
        return {
          title: `${action.desc} (declined)`,
          text: "The user declined this command.",
          isError: true,
        };
      }
      const result = await this.lazyvimium.run(id, args, { browser });
      return {
        text:
          result === undefined || result === null
            ? `Done: ${action.desc}`
            : `Done: ${action.desc}\n${JSON.stringify(result)}`,
      };
    });
  }
}
