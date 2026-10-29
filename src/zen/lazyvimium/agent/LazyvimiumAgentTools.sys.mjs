// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// The browser tools an agent gets over MCP. The page tools read and drive
// the tab the user asked from; browser_action reaches every registry action
// marked for agents, the same ones keymaps run.

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

/**
 * The text an agent reads for one observation, after jev's element table.
 *
 * @param {object} page What LazyvimiumAgentContent's observe() returned.
 * @returns {string}
 */
export function formatObservation(page) {
  const lines = [
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
  return [
    {
      name: "page_observe",
      description:
        "Read the tab: its title and URL, every control in view with an id like e12, and the visible text.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "page_act",
      description:
        "Act on the tab and return it afterwards. click, fill (replace a field's text), select (an option of a native list), press (a key such as Enter, Escape, Tab, ArrowDown) or scroll (up or down, or an element into view). element is an id from the latest observation.",
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
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    {
      name: "page_navigate",
      description:
        "Open an http(s) address in the tab, or in a new tab that becomes the one you work on, and return the loaded page.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          newTab: { type: "boolean" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_action",
      description: `Run a browser command on the tab. Some ask the user first. Commands:\n${browserActions
        .map(action => `${action.id}: ${action.desc}${paramsText(action)}`)
        .join("\n")}`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", enum: browserActions.map(action => action.id) },
          args: { type: "object" },
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
 * What an agent's tools work on: one conversation's tab.
 */
export class LazyvimiumAgentToolbox {
  // The dock's title of the last step, for the log.
  #lastTitle = null;

  /**
   * @param {object} options
   * @param {object} options.lazyvimium The Lazyvimium service.
   * @param {() => Element} options.browser The tab's browser.
   * @param {(browser: Element) => void} options.retarget Called when the
   *   agent moves to a new tab.
   * @param {(step: object) => void} options.onStep Each tool call, for the
   *   panel: {tool, title, status, detail}.
   * @param {(question: string) => Promise<boolean>} options.confirm Ask the
   *   user before an action marked "confirm".
   * @param {object} [options.log] The conversation's LazyvimiumAgentLog.
   */
  constructor({ lazyvimium, browser, retarget, onStep, confirm, log = null }) {
    this.lazyvimium = lazyvimium;
    this.browser = browser;
    this.retarget = retarget;
    this.onStep = onStep;
    this.confirm = confirm;
    this.log = log;
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
        text: result?.text,
      });
    }
  }

  async #callTool(name, args) {
    this.#lastTitle = null;
    switch (name) {
      case "page_observe":
        return this.#step("Read the page", () => this.#observeText());
      case "page_act":
        return this.#act(args);
      case "page_navigate":
        return this.#navigate(args);
      case "browser_action":
        return this.#browserAction(args);
    }
    throw new Error(`Unknown tool ${name}`);
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

  #runContent(id, args = {}) {
    return this.lazyvimium.run(id, args, { browser: this.browser() });
  }

  // Observe, waiting out a navigation: the page's actor is gone while the
  // next document loads.
  async #observe() {
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const page = await this.#runContent("agent.observe");
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

  async #observeText() {
    return { text: formatObservation(await this.#observe()) };
  }

  // A load to another site switches processes, and until the new document
  // commits the browser reports neither the new address nor a load: in dev
  // testing, music.youtube.com → www.youtube.com came back as the old page.
  async #waitForAddressChange(before) {
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (
      this.browser()?.currentURI?.spec == before &&
      Date.now() < deadline
    ) {
      await sleep(RETRY_MS);
    }
  }

  // Wait for a navigation an action started, so the agent gets the page it
  // led to rather than the one it left. In dev testing, links answered with
  // the old page made the agent click them again.
  async #settleNavigation() {
    await sleep(NAVIGATION_START_MS);
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (
      this.browser()?.webProgress?.isLoadingDocument &&
      Date.now() < deadline
    ) {
      await sleep(RETRY_MS);
    }
  }

  #act(args) {
    const { action, element, text } = args;
    return this.#step(element ? `${action} ${element}` : action, async () => {
      let result;
      try {
        result = await this.#runContent("agent.act", { action, element, text });
      } catch {
        // The page went away mid-action: a click that navigated.
        result = { ok: true, done: `Did ${action}; the page navigated` };
      }
      if (result.ok && (action == "click" || action == "press")) {
        await this.#settleNavigation();
      }
      const page = await this.#observe();
      const observation = formatObservation(page);
      if (!result.ok) {
        return {
          title: `${action} ${element ?? ""}`.trim(),
          text: `${result.error}\n\n${observation}`,
          isError: true,
        };
      }
      return { title: result.done, text: `${result.done}.\n\n${observation}` };
    });
  }

  #navigate({ url, newTab = false }) {
    return this.#step(`Open ${url}`, async () => {
      let uri;
      try {
        uri = Services.io.newURI(url);
      } catch {
        return { text: `${quote(url)} is not a URL`, isError: true };
      }
      if (!uri.schemeIs("http") && !uri.schemeIs("https")) {
        return { text: "Only http and https addresses open", isError: true };
      }
      const current = this.browser();
      const window = current.documentGlobal;
      const before = newTab ? null : current.currentURI?.spec;
      let browser = current;
      if (newTab) {
        const tab = window.gBrowser.addTrustedTab(uri.spec, {
          ownerTab: window.gBrowser.getTabForBrowser(current),
        });
        window.gBrowser.selectedTab = tab;
        browser = tab.linkedBrowser;
        this.retarget(browser);
      } else {
        browser.fixupAndLoadURIString(uri.spec, {
          triggeringPrincipal:
            Services.scriptSecurityManager.getSystemPrincipal(),
        });
      }
      // The old document can answer before the load replaces it.
      if (before && before != uri.spec) {
        await this.#waitForAddressChange(before);
      }
      await this.#settleNavigation();
      return { text: formatObservation(await this.#observe()) };
    });
  }

  async #browserAction({ id, args = {} }) {
    const action = this.lazyvimium.actions.get(id);
    if (!action || action.agent === false) {
      return { text: `There is no browser command "${id}"`, isError: true };
    }
    return this.#step(action.desc, async () => {
      this.lazyvimium.actions.validate(id, args);
      if (action.agent == "confirm" && !(await this.confirm(action.desc))) {
        return {
          title: `${action.desc} (declined)`,
          text: "The user declined this command.",
          isError: true,
        };
      }
      const result = await this.lazyvimium.run(id, args, {
        browser: this.browser(),
      });
      return {
        text:
          result === undefined || result === null
            ? `Done: ${action.desc}`
            : `Done: ${action.desc}\n${JSON.stringify(result)}`,
      };
    });
  }
}
