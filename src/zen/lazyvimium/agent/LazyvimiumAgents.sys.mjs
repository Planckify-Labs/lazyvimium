// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Conversations between the user and their agent, one per tab. A turn runs
// the agent's CLI with lazyvimium's MCP server, whose token names the tab;
// what the agent says and every browser tool it calls land in the
// conversation, which the agent dock shows.

import {
  LazyvimiumAgentDetect,
  runForOutput,
} from "resource:///modules/lazyvimium/agent/LazyvimiumAgentDetect.sys.mjs";
import {
  LAZYVIMIUM_DRIVERS,
  LazyvimiumAgentRun,
} from "resource:///modules/lazyvimium/agent/LazyvimiumAgentHarness.sys.mjs";
import { LazyvimiumAgentLog } from "resource:///modules/lazyvimium/agent/LazyvimiumAgentLog.sys.mjs";
import { LazyvimiumAgentServer } from "resource:///modules/lazyvimium/agent/LazyvimiumAgentServer.sys.mjs";
import {
  LazyvimiumAgentToolbox,
  tabIdOf,
} from "resource:///modules/lazyvimium/agent/LazyvimiumAgentTools.sys.mjs";
import { LazyvimiumTheme } from "resource:///modules/lazyvimium/ui/LazyvimiumTheme.sys.mjs";

export const PREF_DEFAULT_AGENT = "lazyvimium.agent.default";
// lazyvimium.agent.model.<agent id>: the model each agent runs with.
export const PREF_MODEL = "lazyvimium.agent.model.";

/**
 * @typedef {object} LazyvimiumAgentMessage
 * @property {"user"|"agent"|"step"|"tool"|"confirm"|"error"|"note"} type
 *   Who said it: the user, the agent, a browser tool call, one of the
 *   agent's own tools, a question for the user, or the browser.
 * @property {string} text What the dock shows.
 * @property {string} [status] For step: running, done or failed; for
 *   confirm: pending, allowed or declined.
 * @property {(allowed: boolean) => void} [answer] For a pending confirm.
 */

let gRunIds = 0;

export class LazyvimiumAgentConversation {
  /** @type {LazyvimiumAgentMessage[]} */
  messages = [];
  /** @type {LazyvimiumAgentRun|null} */
  run = null;
  /** The agent's id of this conversation, to resume it. */
  resume = null;
  startedAt = 0;
  /** Whether a finished turn has not been looked at yet. */
  unseen = false;
  /** @type {LazyvimiumAgentLog|null} The trace of this conversation. */
  log = null;

  #turns = 0;
  #listeners = new Set();
  #browser;
  #service;

  /**
   * @param {LazyvimiumAgentService} service
   * @param {Element} browser
   * @param {object} agent A detected agent, with its path.
   */
  constructor(service, browser, agent) {
    this.#service = service;
    this.#browser = browser;
    this.tabs.add(browser);
    this.agent = agent;
  }

  get browser() {
    return this.#browser;
  }

  get running() {
    return !!this.run || this.#starting;
  }

  #starting = false;

  /**
   * Work on another tab from now on. Only the service calls this, keeping
   * its tab-to-conversation map in step.
   *
   * @param {Element} browser
   */
  moveTo(browser) {
    this.#browser = browser;
    this.tabs.add(browser);
  }

  /**
   * The browsers of every tab the conversation worked on, where the panel
   * shows it.
   *
   * @type {Set<Element>}
   */
  tabs = new Set();

  /**
   * The tabs the agent opened, which it may close without asking.
   *
   * @type {WeakSet<Element>}
   */
  opened = new WeakSet();

  /**
   * @param {() => void} listener Called whenever anything changes.
   * @returns {() => void} Removes it.
   */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  changed() {
    for (const listener of this.#listeners) {
      try {
        listener(this);
      } catch (e) {
        console.error("Lazyvimium: agent listener failed", e);
      }
    }
  }

  #push(message) {
    this.messages.push(message);
    this.changed();
    return message;
  }

  /**
   * Switch agents. The next turn starts a new conversation with it.
   *
   * @param {object} agent
   */
  setAgent(agent) {
    if (this.running || agent.id == this.agent.id) {
      return;
    }
    this.agent = agent;
    this.resume = null;
    this.log = null;
    this.#push({ type: "note", text: `Now talking to ${agent.name}` });
  }

  /**
   * Ask the agent something about this tab.
   *
   * @param {string} text
   */
  async send(text) {
    text = text.trim();
    if (!text || this.running) {
      return;
    }
    const driver = LAZYVIMIUM_DRIVERS[this.agent.id];
    this.#push({ type: "user", text });
    this.startedAt = Date.now();
    this.unseen = false;
    const first = !this.resume;
    let current = null;
    this.log ??= new LazyvimiumAgentLog({
      dir: this.#service.logDir,
      agent: this.agent.id,
    });
    const log = this.log;
    log.write("turn", {
      turn: ++this.#turns,
      agent: this.agent.id,
      version: this.agent.version,
      model: this.#service.modelFor(this.agent.id) || null,
      executable: this.agent.path,
      resume: this.resume,
      url: this.#browser.currentURI?.spec,
      title: this.#browser.contentTitle,
      request: text,
    });
    const toolbox = new LazyvimiumAgentToolbox({
      lazyvimium: this.#service.lazyvimium,
      browser: () => this.#browser,
      retarget: browser => this.#service.retarget(this, browser),
      onStep: step => this.#onStep(step),
      confirm: question => this.#confirm(question),
      log,
      opened: this.opened,
    });
    const token = LazyvimiumAgentServer.open(toolbox);
    this.#starting = true;
    this.changed();
    const path = await LazyvimiumAgentDetect.childPath();
    const connected =
      !driver.ensureConnected ||
      (await this.#service.ensureConnected(this.agent));
    this.#starting = false;
    if (!connected) {
      LazyvimiumAgentServer.close(token);
      const error = `Could not add lazyvimium to ${this.agent.name}'s MCP servers`;
      log.write("done", { error, ms: Date.now() - this.startedAt });
      this.#push({ type: "error", text: error });
      return;
    }
    this.run = new LazyvimiumAgentRun({
      driver,
      executable: this.agent.path,
      path,
      log,
      turn: {
        prompt: this.#prompt(text),
        resume: this.resume,
        model: this.#service.modelFor(this.agent.id) || null,
        first,
        mcp: { url: LazyvimiumAgentServer.url, token },
        dir: this.#service.workDir,
        runId: `${Date.now()}-${++gRunIds}`,
      },
      onEvent: event => {
        switch (event.type) {
          case "session":
            this.resume = event.id;
            break;
          case "text":
            if (event.final && current) {
              // The whole message, after the pieces streamed into it.
              current.text = event.text;
              this.changed();
            } else if (event.delta && current) {
              current.text += event.text;
              this.changed();
            } else {
              current = this.#push({ type: "agent", text: event.text });
            }
            if (!event.delta) {
              current = null;
            }
            break;
          case "tool":
            current = null;
            this.#push({ type: "tool", text: event.name });
            break;
          case "done":
            if (event.error) {
              this.#push({ type: "error", text: event.error });
            }
            break;
        }
      },
    });
    this.#service.setDriving(this, true);
    this.changed();
    await this.run.start();
    const error = await this.run.done;
    LazyvimiumAgentServer.close(token);
    log.write("done", { error, ms: Date.now() - this.startedAt });
    if (error && log.path) {
      this.#push({ type: "note", text: `Details: ${log.path}` });
    }
    for (const message of this.messages) {
      if (message.type == "confirm" && message.status == "pending") {
        message.answer(false);
      }
    }
    this.run = null;
    this.unseen = true;
    this.#service.setDriving(this, false);
    this.changed();
  }

  stop() {
    this.run?.stop();
  }

  // The request with what the agent needs to know about the tab.
  #prompt(text) {
    const browser = this.#browser;
    const title = browser.contentTitle || browser.currentURI?.spec || "";
    const tab = browser.documentGlobal?.gBrowser.getTabForBrowser(browser);
    const id = tab ? `${tabIdOf(tab)} ` : "";
    return `You work on the tab ${id}"${title}" (${browser.currentURI?.spec}).\n\nThe user's request: ${text}`;
  }

  #onStep(step) {
    let message = this.messages.findLast(m => m.step === step);
    if (!message) {
      message = this.#push({ type: "step", step, text: step.title });
    }
    message.text = step.title;
    message.status = step.status;
    message.detail = step.detail;
    this.changed();
  }

  #confirm(question) {
    const { promise, resolve } = Promise.withResolvers();
    const message = this.#push({
      type: "confirm",
      text: question,
      status: "pending",
      answer: allowed => {
        if (message.status != "pending") {
          return;
        }
        message.status = allowed ? "allowed" : "declined";
        this.log?.write("confirm", { question, allowed });
        this.changed();
        resolve(allowed);
      },
    });
    return promise;
  }

  /** The pending question, if the agent is waiting for one. */
  get pendingConfirm() {
    return (
      this.messages.findLast(
        m => m.type == "confirm" && m.status == "pending"
      ) ?? null
    );
  }
}

class LazyvimiumAgentService {
  /** @type {WeakMap<Element, LazyvimiumAgentConversation>} */
  #conversations = new WeakMap();
  #connected = new Map();

  /** Set by Lazyvimium. */
  lazyvimium = null;

  get workDir() {
    return PathUtils.join(PathUtils.profileDir, "lazyvimium", "agent");
  }

  get logDir() {
    return PathUtils.join(this.workDir, "logs");
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.refresh]
   */
  agents(options) {
    return LazyvimiumAgentDetect.detect(options);
  }

  /**
   * The agent asked first: the user's pick, else the first one installed.
   *
   * @returns {Promise<object|null>}
   */
  async defaultAgent() {
    const installed = await LazyvimiumAgentDetect.installed();
    const id = Services.prefs.getStringPref(PREF_DEFAULT_AGENT, "");
    return installed.find(agent => agent.id == id) ?? installed[0] ?? null;
  }

  /**
   * @param {string} id
   */
  setDefaultAgent(id) {
    Services.prefs.setStringPref(PREF_DEFAULT_AGENT, id);
  }

  /**
   * @param {string} id An agent id.
   * @returns {string} The model the user picked for it, or "" for the one
   *   the agent's own settings pick.
   */
  modelFor(id) {
    return Services.prefs.getStringPref(`${PREF_MODEL}${id}`, "");
  }

  /**
   * @param {string} id An agent id.
   * @param {string} model "" goes back to the agent's own pick.
   */
  setModel(id, model) {
    if (model) {
      Services.prefs.setStringPref(`${PREF_MODEL}${id}`, model);
    } else {
      Services.prefs.clearUserPref(`${PREF_MODEL}${id}`);
    }
  }

  #models = new Map();

  /**
   * The models an agent offers, as its CLI lists them. Asked once a session.
   *
   * @param {object} agent A detected agent.
   * @param {object} [options]
   * @param {boolean} [options.refresh]
   * @returns {Promise<{id: string, name: string, detail?: string}[]>}
   */
  models(agent, { refresh = false } = {}) {
    const driver = LAZYVIMIUM_DRIVERS[agent.id];
    if (!driver?.models || !agent.path) {
      return Promise.resolve([]);
    }
    if (refresh || !this.#models.has(agent.id)) {
      const promise = driver
        .models(async args =>
          runForOutput(agent.path, args, {
            ms: 30000,
            environment: { PATH: await LazyvimiumAgentDetect.childPath() },
          })
        )
        .catch(e => {
          console.error(`Lazyvimium: listing ${agent.name}'s models failed`, e);
          return [];
        });
      this.#models.set(agent.id, promise);
      promise.then(models => !models.length && this.#models.delete(agent.id));
    }
    return this.#models.get(agent.id);
  }

  /**
   * Let an agent that needs it reach lazyvimium (Antigravity's MCP config).
   *
   * @param {object} agent A detected agent.
   * @returns {Promise<boolean>}
   */
  ensureConnected(agent) {
    const driver = LAZYVIMIUM_DRIVERS[agent.id];
    if (!driver?.ensureConnected || !agent.path) {
      return Promise.resolve(!!agent.path);
    }
    if (!this.#connected.has(agent.id)) {
      const promise = driver.ensureConnected(async args =>
        runForOutput(agent.path, args, {
          ms: 20000,
          environment: { PATH: await LazyvimiumAgentDetect.childPath() },
        })
      );
      this.#connected.set(agent.id, promise);
      promise.then(ok => !ok && this.#connected.delete(agent.id));
    }
    return this.#connected.get(agent.id);
  }

  /**
   * @param {Element} browser
   * @returns {LazyvimiumAgentConversation|null}
   */
  conversationFor(browser) {
    return this.#conversations.get(browser) ?? null;
  }

  /**
   * The tab's conversation, started with the default agent if it has none.
   *
   * @param {Element} browser
   * @returns {Promise<LazyvimiumAgentConversation|null>} Null when no agent
   *   is installed.
   */
  async open(browser) {
    let conversation = this.#conversations.get(browser);
    if (!conversation) {
      const agent = await this.defaultAgent();
      if (!agent) {
        return null;
      }
      conversation = this.#conversations.get(browser);
      if (!conversation) {
        conversation = new LazyvimiumAgentConversation(this, browser, agent);
        this.#conversations.set(browser, conversation);
      }
    }
    return conversation;
  }

  /**
   * Forget a tab's conversation, stopping its turn.
   *
   * @param {Element} browser
   */
  reset(browser) {
    const conversation = this.#conversations.get(browser);
    conversation?.stop();
    this.#conversations.delete(browser);
    for (const tab of conversation?.tabs ?? []) {
      if (this.#conversations.get(tab) == conversation) {
        this.#conversations.delete(tab);
      }
    }
    return conversation;
  }

  // The agent works on another tab from now on. The conversation stays on
  // the tabs it worked on before, and comes to the new one unless that tab
  // has a conversation of its own.
  retarget(conversation, browser) {
    if (browser == conversation.browser) {
      return;
    }
    const driving = conversation.running;
    this.setDriving(conversation, false);
    if (!this.#conversations.has(browser)) {
      this.#conversations.set(browser, conversation);
    }
    conversation.moveTo(browser);
    if (driving) {
      this.setDriving(conversation, true);
    }
  }

  // The glow around the tab the agent works on, drawn over the page by its
  // browser's stack.
  setDriving(conversation, driving) {
    const browser = conversation.browser;
    const stack = browser.parentElement ?? browser;
    for (const element of new Set([browser, stack])) {
      element.toggleAttribute("lazyvimium-agent-driving", driving);
    }
    stack.style.setProperty(
      "--lazyvimium-agent-color",
      agentColor(conversation.agent.id)
    );
  }
}

/**
 * One color per agent for its dot and the glow around the tab it drives,
 * from lazyvimium's theme.
 *
 * @param {string} id
 * @returns {string}
 */
export function agentColor(id) {
  return LazyvimiumTheme.agentColor(id);
}

export const LazyvimiumAgents = new LazyvimiumAgentService();
