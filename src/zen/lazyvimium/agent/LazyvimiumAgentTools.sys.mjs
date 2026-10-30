// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// The browser tools an agent gets over MCP. The agent works on one tab at a
// time, at first the one the user asked from; the tab tools list, open,
// switch between and close the window's tabs, each known by an id like t3,
// and the page tools read and drive the tab it works on or any tab it
// names. browser_action reaches every registry action marked for agents,
// the same ones keymaps run. The ui tools show tables and pages in the
// panel (LazyvimiumAgentUi).

import {
  pageFromArgs,
  tableFromArgs,
  uiGuide,
  uiToolDefinitions,
} from "resource:///modules/lazyvimium/agent/LazyvimiumAgentUi.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const LOAD_TIMEOUT_MS = 15000;
const RETRY_MS = 100;
// How long a click takes to start the navigation it causes, if it does.
const NAVIGATION_START_MS = 250;
const NAVIGATION_POLL_MS = 25;
const NAVIGATION_COMMIT_MS = 3000;
// Frames read per observation, and how deep: ads and trackers can nest
// dozens, and each one costs a round trip to its process.
const MAX_FRAMES = 12;
const MAX_FRAME_DEPTH = 3;
const FRAME_TIMEOUT_MS = 1500;
const QUERY_TIMEOUT_MS = 5000;
// Wide enough to read a page, narrow enough to be cheap as image input.
const WAIT_DEFAULT_MS = 5000;
const WAIT_MAX_MS = 15000;
const WAIT_POLL_MS = 100;
const WAIT_SETTLE_MAX_MS = 2000;
const SCREENSHOT_MAX_WIDTH = 1280;
const SCREENSHOT_QUALITY = 0.8;

// An element id is e12 in the tab's own document and f7.e12 in the frame
// whose browsing context has id 7.
// A page that navigates can drop a query without ever answering it: in dev
// testing, the call after a click on a link hung until the test gave up.
function withTimeout(promise, ms = QUERY_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) =>
      lazy.setTimeout(
        () => reject(new Error("The page did not answer in time")),
        ms
      )
    ),
  ]);
}

// The page answered, and said the scope asked for is not one it has.
class ScopeRefused extends Error {}

function parseElementId(id) {
  const match = /^f(\d+)\.(e\d+)$/.exec(String(id ?? ""));
  return match ? { frame: Number(match[1]), local: match[2] } : null;
}

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

/**
 * @param {Window} window
 * @param {string} id An id like t3.
 * @returns {Element|null} The tab it names.
 */
export function findTab(window, id) {
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
  const prefix = page.prefix ?? "";
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
  lines.push("", ...elementLines(page, prefix), ...frameLines(page));
  return lines.join("\n");
}

// CAPTCHAs are checks for a person, so the agent is told to hand them over
// rather than shown their pieces to click. In dev testing it scrolled a page
// up and down for minutes looking for the one inside an iframe.
const CAPTCHAS = [
  [/google\.com\/recaptcha\/|recaptcha\.net\//, "reCAPTCHA"],
  [/hcaptcha\.com\//, "hCaptcha"],
  [/challenges\.cloudflare\.com\//, "Cloudflare Turnstile"],
  [/arkoselabs\.com\/|funcaptcha\.com\//, "Arkose"],
  [/geetest\.com\//, "GeeTest"],
];

function captchaOf(url) {
  return CAPTCHAS.find(([pattern]) => pattern.test(url))?.[1] ?? null;
}

// Frame ids are flat, nested ones included: a browsing context id is unique
// in the browser, and names the frame without its parents.
function frameLines(page) {
  const lines = [];
  for (const frame of page.frames ?? []) {
    const id = `f${frame.id}`;
    const url = frame.page?.url || frame.src || "";
    const where = `at ${frame.rect.x},${frame.rect.y} ${frame.rect.w}x${frame.rect.h}`;
    const name = frame.title || frame.page?.title;
    lines.push(
      "",
      `Frame ${id}${name ? ` ${quote(name)}` : ""} ${where}${url ? `: ${url}` : ""}`
    );
    const captcha = captchaOf(url);
    if (captcha) {
      lines.push(
        `This is a ${captcha} challenge, a check made for the user. Do not click in it or try to solve it. Tell the user to complete it, then observe again.`
      );
    } else if (frame.skipped) {
      lines.push("(not read: too many frames)");
    } else if (!frame.page) {
      lines.push("(could not be read)");
    } else {
      lines.push(
        ...elementLines(frame.page, `f${frame.id}.`),
        ...frameLines(frame.page)
      );
    }
  }
  return lines;
}

// The page's landmarks and headings, indented by heading level, so the agent
// can see what is off screen and read one part of it.
function outlineLines(page, prefix = "") {
  if (!page.outline) {
    return [];
  }
  const lines = ["Outline (use an id as scope to read only that part):"];
  if (!page.outline.length) {
    lines.push("(none)");
  }
  for (const entry of page.outline) {
    const indent = entry.level ? "  ".repeat(entry.level - 1) : "";
    const name = entry.label ? ` ${quote(entry.label)}` : "";
    const level = entry.level ? ` ${entry.level}` : "";
    lines.push(
      `${indent}[${prefix}${entry.id}] ${entry.role}${level}${name}${entry.inView ? "" : " (out of view)"}`
    );
  }
  return [...lines, ""];
}

function elementLines(page, prefix = "") {
  const lines = [
    ...outlineLines(page, prefix),
    page.scope ? `Elements in ${prefix}${page.scope}:` : "Elements in view:",
  ];
  if (!page.elements.length) {
    lines.push("(none)");
  }
  for (const element of page.elements) {
    let line = `[${prefix}${element.id}] ${element.role} ${quote(element.label)}`;
    if (element.description) {
      line += ` description=${quote(element.description)}`;
    }
    if (element.value !== undefined) {
      line += ` value=${quote(element.value)}`;
    }
    for (const key of ["checked", "selected", "expanded", "pressed"]) {
      if (element[key] !== undefined) {
        line += ` ${key}=${element[key]}`;
      }
    }
    for (const flag of ["focused", "required", "invalid"]) {
      if (element[flag]) {
        line += ` ${flag}`;
      }
    }
    if (element.error) {
      line += ` error=${quote(element.error)}`;
    }
    if (element.editable) {
      line += " (editable)";
    }
    if (element.covered) {
      line += ` (covered by ${element.covered})`;
    }
    if (element.options) {
      line += ` options: ${element.options.map(quote).join(", ")}`;
      if (element.moreOptions) {
        line += ` and ${element.moreOptions} more (select takes any option's text)`;
      }
    }
    lines.push(line);
  }
  if (page.omitted) {
    lines.push(`(${page.omitted} more not listed; scroll or act to see them)`);
  }
  lines.push("", "Visible text:", page.text || "(none)");
  return lines;
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
        "Read a tab: its title and URL, every control in view with an id like e12, and the visible text. Frames on the page (embedded forms, logins, players) are read too, their ids like f7.e3. A CAPTCHA is not for you to solve: ask the user to complete it. On a large page, read it in parts: outline true adds the page's landmarks and headings, each with an id, and scope with one of those ids reads only what is inside it, all of it rather than what is in view.",
      inputSchema: {
        type: "object",
        properties: {
          tab,
          outline: {
            type: "boolean",
            description: "Also list the page's landmarks and headings",
          },
          scope: {
            type: "string",
            description:
              "An id from the outline: read only the controls and text inside it",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "page_wait",
      description:
        "Wait for the page to change, then return it. Use after something that loads or opens content (a click that starts a request, a menu, a dialog) instead of guessing a delay. Returns early when the page changes, or says it did not change.",
      inputSchema: {
        type: "object",
        properties: {
          timeout_ms: {
            type: "number",
            description: `How long to wait at most, up to ${WAIT_MAX_MS}; ${WAIT_DEFAULT_MS} if left out`,
          },
          tab,
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "page_screenshot",
      description:
        "A picture of what the tab shows now, canvases and frames included. Only useful if you can see images; page_observe is the text of the same view.",
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
          element: {
            type: "string",
            description: "An id such as e12, or f7.e3 inside a frame",
          },
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
    ...uiToolDefinitions(),
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
   * @param {(ui: object) => string} [options.onUi] Show a table or page in
   *   the panel; returns its id. Without it the ui tools refuse.
   */
  constructor({
    lazyvimium,
    browser,
    retarget,
    onStep,
    confirm,
    log = null,
    opened = new WeakSet(),
    onUi = null,
  }) {
    this.lazyvimium = lazyvimium;
    this.browser = browser;
    this.retarget = retarget;
    this.onStep = onStep;
    this.confirm = confirm;
    this.log = log;
    this.opened = opened;
    this.onUi = onUi;
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
          text: await this.#observeText(browser, args),
        }));
      case "page_wait":
        return this.#wait(args);
      case "page_screenshot":
        return this.#onTab(args.tab, "Took a screenshot", browser =>
          this.#screenshot(browser)
        );
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
      case "ui_table":
      case "ui_show":
        return this.#showUi(name, args);
      case "ui_guide":
        return { text: uiGuide(args.topic) };
    }
    throw new Error(`Unknown tool ${name}`);
  }

  // The table or page is its own row in the panel, so no step row.
  #showUi(name, args) {
    if (!this.onUi) {
      throw new Error("There is no panel to show it in.");
    }
    const ui = name == "ui_table" ? tableFromArgs(args) : pageFromArgs(args);
    const id = this.onUi(ui);
    this.#lastTitle = `Showed ${quote(ui.title)}`;
    return {
      text: `The user sees it in the panel as ${quote(id)}; call ${name} with id ${quote(id)} to change it. Do not repeat what it shows in your answer.`,
    };
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
      return {
        text: result.text,
        isError: !!result.isError,
        ...(result.image && { image: result.image }),
      };
    } catch (e) {
      step.status = "failed";
      step.detail = String(e.message ?? e);
      this.onStep(step);
      throw e;
    }
  }

  #runContent(browser, id, args = {}) {
    return withTimeout(this.lazyvimium.run(id, args, { browser }));
  }

  // A query to a frame's actor.
  #queryFrame(actor, id, args = {}) {
    return withTimeout(actor.sendQuery("Lazyvimium:RunContent", { id, args }));
  }

  // The actor of a frame of the tab, if it is still there. Its document may
  // be in another process; the actor is how to reach it.
  #frameActor(browser, frame) {
    const context = BrowsingContext.get(frame);
    if (context?.top.id != browser.browsingContext.id) {
      return null;
    }
    return context.currentWindowGlobal?.getActor("LazyvimiumKeys") ?? null;
  }

  // Read a frame, waiting out its load as the tab is.
  async #observeFrame(browser, frame, args = {}) {
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    let page = null;
    while (Date.now() < deadline) {
      try {
        const actor = this.#frameActor(browser, frame);
        page = actor && (await this.#queryFrame(actor, "agent.observe", args));
        if (page && !page.loading) {
          return page;
        }
      } catch {
        // The frame is navigating, or has no actor yet.
      }
      await sleep(RETRY_MS);
    }
    return page;
  }

  // Put what each visible frame shows under it, in the frames' own order,
  // CAPTCHAs aside, which are not for the agent to read.
  async #readFrames(
    browser,
    page,
    args = {},
    budget = { left: MAX_FRAMES },
    depth = 0
  ) {
    const frames = page.frames ?? [];
    for (const frame of frames) {
      if (captchaOf(frame.src)) {
        continue;
      }
      frame.skipped = budget.left <= 0 || depth >= MAX_FRAME_DEPTH;
      if (!frame.skipped) {
        budget.left--;
      }
    }
    await Promise.all(
      frames
        .filter(frame => !frame.skipped && !captchaOf(frame.src))
        .map(async frame => {
          frame.page = await this.#observeFrame(browser, frame.id, args);
          if (frame.page) {
            await this.#readFrames(
              browser,
              frame.page,
              args,
              budget,
              depth + 1
            );
          }
        })
    );
  }

  // Observe, waiting out a navigation: the page's actor is gone while the
  // next document loads.
  async #observe(browser, { scope, outline } = {}) {
    const args = { ...(outline && { outline }) };
    const inFrame = parseElementId(scope);
    if (inFrame) {
      // A region of a frame: only that frame is read, its ids still saying
      // which frame they are in.
      const page = await this.#observeFrame(browser, inFrame.frame, {
        ...args,
        scope: inFrame.local,
      });
      if (!page || page.error) {
        throw new Error(
          page?.error ?? `${scope} is no longer on the page. Observe again.`
        );
      }
      page.prefix = `f${inFrame.frame}.`;
      return page;
    }
    if (scope) {
      args.scope = scope;
    }
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    let lastError = null;
    let failures = 0;
    while (Date.now() < deadline) {
      try {
        const page = await this.#runContent(browser, "agent.observe", args);
        if (page.error) {
          throw new ScopeRefused(page.error);
        }
        if (!page.loading || Date.now() + RETRY_MS >= deadline) {
          await this.#readFrames(
            browser,
            page,
            args.outline ? { outline: true } : {}
          );
          return page;
        }
      } catch (e) {
        if (e instanceof ScopeRefused) {
          throw e;
        }
        lastError = e;
        // A page between documents has no actor for a moment and is worth
        // waiting for. An error on a settled page will come again: in dev
        // testing one bug in the reader made every call wait out the whole
        // 15 seconds before saying so.
        if (!browser.webProgress?.isLoadingDocument && ++failures >= 3) {
          throw new Error(`The page could not be read: ${e.message}`);
        }
      }
      await sleep(RETRY_MS);
    }
    throw new Error(
      `The page did not respond${lastError ? `: ${lastError.message}` : ""}`
    );
  }

  async #observeText(browser, options) {
    return formatObservation(
      await this.#observe(browser, options),
      this.#idOf(browser)
    );
  }

  // Where the tab and the frames in it stand in their changes, as one string
  // that differs when anything does.
  async #versionOf(browser, frame = null, depth = 0) {
    const actor = frame === null ? null : this.#frameActor(browser, frame);
    const info = actor
      ? await this.#queryFrame(actor, "agent.version")
      : frame === null && (await this.#runContent(browser, "agent.version"));
    if (!info) {
      return "gone";
    }
    const parts = [info.loading ? "loading" : info.version];
    if (depth < MAX_FRAME_DEPTH) {
      for (const id of info.frames.slice(0, MAX_FRAMES)) {
        const version = await this.#versionOf(browser, id, depth + 1).catch(
          () => "error"
        );
        parts.push(`${id}:${version}`);
      }
    }
    return parts.join(",");
  }

  // Wait for the page to change instead of for a fixed time, then for the
  // change to settle: a menu opening is a burst of them.
  #wait({ tab, timeout_ms: timeout }) {
    const limit = Math.min(
      Math.max(timeout ?? WAIT_DEFAULT_MS, 100),
      WAIT_MAX_MS
    );
    return this.#onTab(tab, "Waited for the page", async browser => {
      const key = async () =>
        `${browser.currentURI?.spec}|${browser.webProgress?.isLoadingDocument}|${await this.#versionOf(browser).catch(() => "error")}`;
      const before = await key();
      const deadline = Date.now() + limit;
      let current = before;
      while (current == before && Date.now() < deadline) {
        await sleep(WAIT_POLL_MS);
        current = await key();
      }
      const changed = current != before;
      let quiet = 0;
      const settled = Date.now() + WAIT_SETTLE_MAX_MS;
      while (changed && quiet < 2 && Date.now() < settled) {
        await sleep(WAIT_POLL_MS);
        const next = await key();
        quiet = next == current ? quiet + 1 : 0;
        current = next;
      }
      const observation = await this.#observeText(browser);
      return {
        title: changed ? "The page changed" : "The page did not change",
        text: `${changed ? "The page changed." : `The page did not change in ${limit} ms.`}\n\n${observation}`,
      };
    });
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
  // A page that says it is navigating will replace its document: wait for
  // that, since the load flag the parent sees can come and go before then.
  // A navigation that ends in a download or nothing gives up after a while.
  async #waitForNewDocument(browser, before) {
    const deadline = Date.now() + NAVIGATION_COMMIT_MS;
    while (
      browser.browsingContext.currentWindowGlobal == before &&
      Date.now() < deadline
    ) {
      await sleep(NAVIGATION_POLL_MS);
    }
  }

  async #settleNavigation(browser) {
    // The load shows in the parent a moment after the page starts it.
    const start = Date.now() + NAVIGATION_START_MS;
    while (!browser.webProgress?.isLoadingDocument && Date.now() < start) {
      await sleep(NAVIGATION_POLL_MS);
    }
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (browser.webProgress?.isLoadingDocument && Date.now() < deadline) {
      await sleep(RETRY_MS);
    }
  }

  // What the tab shows, frames of other sites included, as an image.
  async #screenshot(browser) {
    const window = this.window;
    const { width, height } = browser.getBoundingClientRect();
    if (!width || !height) {
      return { text: "The tab has no size to capture.", isError: true };
    }
    const scale = Math.min(
      window.devicePixelRatio,
      SCREENSHOT_MAX_WIDTH / width
    );
    const image =
      await browser.browsingContext.currentWindowGlobal.drawSnapshot(
        null,
        scale,
        "white"
      );
    // Handing the bitmap to the canvas empties it.
    const { width: shotWidth, height: shotHeight } = image;
    const canvas = new window.OffscreenCanvas(shotWidth, shotHeight);
    canvas
      .getContext("bitmaprenderer", { alpha: false })
      .transferFromImageBitmap(image);
    const blob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: SCREENSHOT_QUALITY,
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return {
      title: "Took a screenshot",
      text: `Screenshot of ${this.#idOf(browser)}, ${shotWidth}x${shotHeight}px, showing what is in view.`,
      image: { data: window.btoa(binary), mimeType: "image/jpeg" },
    };
  }

  #act(args) {
    const { action, element, text, tab } = args;
    const title = [action, element, tab && `on ${tab}`]
      .filter(Boolean)
      .join(" ");
    return this.#onTab(tab, title, async browser => {
      let result;
      const before = browser.browsingContext.currentWindowGlobal;
      const inFrame = parseElementId(element);
      const actor = inFrame && this.#frameActor(browser, inFrame.frame);
      if (inFrame && !actor) {
        result = {
          ok: false,
          error: `${element} is no longer on the page. Observe again.`,
        };
      } else {
        const local = { action, element: inFrame?.local ?? element, text };
        try {
          result = await (actor
            ? this.#queryFrame(actor, "agent.act", local)
            : this.#runContent(browser, "agent.act", local));
        } catch {
          // The page went away mid-action: a click that navigated.
          result = {
            ok: true,
            done: `Did ${action}; the page navigated`,
            navigated: "document",
            changed: true,
          };
        }
      }
      // Wait for a new page only when the action started one. Waiting after
      // every click cost each a quarter second; jev waits two frames.
      if (result.ok && result.navigated == "document" && !inFrame) {
        await this.#waitForNewDocument(browser, before);
      }
      if (
        result.ok &&
        (result.navigated == "document" ||
          browser.webProgress?.isLoadingDocument)
      ) {
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
      // jev stops a run after three actions that change nothing; the agent
      // here is told, so it does not repeat one.
      const unchanged =
        result.changed === false && action != "scroll"
          ? " Nothing on the page changed. If it is still working, page_wait; otherwise do something else rather than repeat this."
          : "";
      return {
        title: tab ? `${result.done} on ${tab}` : result.done,
        text: `${result.done}.${unchanged}\n\n${observation}`,
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
