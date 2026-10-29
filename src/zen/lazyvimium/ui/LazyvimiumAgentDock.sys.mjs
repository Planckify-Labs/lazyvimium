// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// The agent dock: a bar at the foot of the tab to ask the user's agent
// something about it, which grows into the conversation above it while the
// agent works. Closed, a pill keeps showing that the agent is working on
// the tab or has finished.

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  LazyvimiumAgents:
    "resource:///modules/lazyvimium/agent/LazyvimiumAgents.sys.mjs",
  agentColor: "resource:///modules/lazyvimium/agent/LazyvimiumAgents.sys.mjs",
  LazyvimiumPicker:
    "resource:///modules/lazyvimium/ui/LazyvimiumPicker.sys.mjs",
});

const HTML_NS = "http://www.w3.org/1999/xhtml";
const STEP_ICONS = { running: "◌", done: "✓", failed: "✕" };

function formatElapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export class LazyvimiumAgentDock {
  #window;
  #root;
  #log;
  #input;
  #agentChip;
  #tabChip;
  #status;
  #hint;
  #pill;
  #conversation = null;
  #unsubscribe = null;
  #timer = null;
  #onChange;
  #open = false;

  /**
   * @param {Window} window A browser window.
   * @param {object} options
   * @param {() => void} options.onChange Called when the dock opens or
   *   closes.
   */
  constructor(window, { onChange }) {
    this.#window = window;
    this.#onChange = onChange;
    const document = window.document;
    const create = (tag, className, parent) => {
      const element = document.createElementNS(HTML_NS, tag);
      if (className) {
        element.className = className;
      }
      parent?.append(element);
      return element;
    };

    this.#root = create("div");
    this.#root.id = "lazyvimium-agent-dock";
    this.#root.hidden = true;
    this.#root.setAttribute("role", "dialog");
    this.#root.setAttribute("aria-label", "Ask your agent");

    this.#log = create("div", "lazyvimium-agent-log", this.#root);
    this.#log.setAttribute("role", "log");
    this.#log.setAttribute("aria-live", "polite");

    const composer = create("div", "lazyvimium-agent-composer", this.#root);
    const chips = create("div", "lazyvimium-agent-chips", composer);
    this.#agentChip = create("button", "lazyvimium-agent-chip", chips);
    this.#agentChip.title = "Pick an agent (Tab)";
    this.#agentChip.addEventListener("click", () => this.pickAgent());
    this.#tabChip = create("span", "lazyvimium-agent-tab", chips);
    this.#status = create("span", "lazyvimium-agent-status", chips);

    this.#input = create("textarea", "lazyvimium-agent-input", composer);
    this.#input.rows = 1;
    this.#input.setAttribute("aria-label", "Ask your agent");
    this.#input.addEventListener("keydown", event => this.#onKey(event));
    this.#input.addEventListener("input", () => this.#fitInput());

    this.#hint = create("div", "lazyvimium-agent-hint", composer);

    this.#pill = create("button");
    this.#pill.id = "lazyvimium-agent-pill";
    this.#pill.hidden = true;
    this.#pill.addEventListener("click", () =>
      this.open(this.#window.gBrowser.selectedBrowser)
    );

    const host = document.getElementById("browser") ?? document.documentElement;
    host.append(this.#root, this.#pill);
    window.gBrowser.tabContainer.addEventListener("TabSelect", () =>
      this.#onTabSelect()
    );
  }

  get isOpen() {
    return this.#open;
  }

  /**
   * Open the dock on a tab, with its conversation.
   *
   * @param {Element} browser
   */
  async open(browser) {
    this.#open = true;
    this.#root.hidden = false;
    this.#pill.hidden = true;
    this.#onChange();
    const conversation = await lazy.LazyvimiumAgents.open(browser);
    if (!this.#open || this.#window.gBrowser.selectedBrowser != browser) {
      return;
    }
    this.#bind(conversation);
    if (conversation) {
      conversation.unseen = false;
    }
    this.#render();
    this.#input.focus();
  }

  close() {
    if (!this.#open) {
      return;
    }
    const focused = this.#root.contains(this.#window.document.activeElement);
    this.#open = false;
    this.#root.hidden = true;
    this.#syncPill();
    this.#onChange();
    // Only hand the keys back when the dock had them, not when another
    // buffer opening closed it.
    if (focused) {
      this.#window.gBrowser.selectedBrowser.focus();
    }
  }

  /**
   * @param {Node} node
   * @returns {boolean} Whether the node is part of the dock.
   */
  contains(node) {
    return !!node && (this.#root.contains(node) || this.#pill.contains(node));
  }

  /**
   * @param {Element} browser
   */
  toggle(browser) {
    if (this.#open) {
      this.close();
    } else {
      this.open(browser);
    }
  }

  stop() {
    this.#conversation?.stop();
  }

  /**
   * Start over on the tab: stop the turn and forget the conversation.
   *
   * @param {Element} browser
   */
  reset(browser) {
    lazy.LazyvimiumAgents.reset(browser);
    this.#bind(null);
    this.open(browser);
  }

  /**
   * Open the tab's conversation log, or the folder of all of them, in a new
   * tab next to it.
   *
   * @param {Element} browser
   */
  async openLog(browser) {
    const log = lazy.LazyvimiumAgents.conversationFor(browser)?.log;
    await log?.flush();
    const dir = lazy.LazyvimiumAgents.logDir;
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    const path = log?.path ?? dir;
    this.#window.openTrustedLinkIn(PathUtils.toFileURI(path), "tab", {
      relatedToCurrent: true,
    });
  }

  /**
   * Choose the agent for this tab, and for new ones.
   */
  async pickAgent() {
    const agents = await lazy.LazyvimiumAgents.agents({ refresh: true });
    const current = this.#conversation?.agent.id;
    const index = await lazy.LazyvimiumPicker.open(this.#window, {
      title: "Agents",
      items: agents.map(agent => ({
        label: `${agent.name}${agent.id == current ? "  ·  current" : ""}`,
        detail: agent.path
          ? `${agent.version ?? ""} ${agent.path}`.trim()
          : `not installed: ${agent.install}`,
      })),
    });
    const agent = agents[index];
    if (!agent?.path) {
      this.#input.focus();
      return;
    }
    lazy.LazyvimiumAgents.setDefaultAgent(agent.id);
    this.#conversation?.setAgent(agent);
    if (this.#open) {
      this.#render();
      this.#input.focus();
    } else {
      this.open(this.#window.gBrowser.selectedBrowser);
    }
  }

  #bind(conversation) {
    if (conversation == this.#conversation) {
      return;
    }
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#conversation = conversation;
    if (conversation) {
      this.#unsubscribe = conversation.subscribe(() => this.#onConversation());
    }
  }

  #onConversation() {
    const conversation = this.#conversation;
    if (this.#open && conversation) {
      conversation.unseen = false;
    }
    if (conversation?.pendingConfirm && !this.#open) {
      // The agent waits on the user: show the question.
      this.open(conversation.browser);
      return;
    }
    this.#render();
    this.#syncPill();
  }

  #onTabSelect() {
    const browser = this.#window.gBrowser.selectedBrowser;
    if (this.#open) {
      this.open(browser);
    } else {
      this.#bind(lazy.LazyvimiumAgents.conversationFor(browser));
      this.#syncPill();
    }
  }

  #onKey(event) {
    const conversation = this.#conversation;
    const empty = !this.#input.value;
    const pending = conversation?.pendingConfirm;
    const plain = !event.ctrlKey && !event.altKey && !event.metaKey;
    let handled = true;
    if (event.key == "Escape") {
      this.close();
    } else if (
      pending &&
      empty &&
      plain &&
      (event.key == "y" || event.key == "n")
    ) {
      pending.answer(event.key == "y");
    } else if (event.key == "Enter" && !event.shiftKey) {
      this.#send();
    } else if (event.key == "c" && event.ctrlKey && conversation?.running) {
      conversation.stop();
    } else if (event.key == "Tab" && plain) {
      this.#cycleAgent(event.shiftKey ? -1 : 1);
    } else {
      handled = false;
    }
    if (handled) {
      event.preventDefault();
    }
    // The page's keys never see what is typed here.
    event.stopPropagation();
  }

  async #cycleAgent(direction) {
    const conversation = this.#conversation;
    if (!conversation || conversation.running) {
      return;
    }
    const installed = (await lazy.LazyvimiumAgents.agents()).filter(
      agent => agent.path
    );
    const index = installed.findIndex(
      agent => agent.id == conversation.agent.id
    );
    const next =
      installed[(index + direction + installed.length) % installed.length];
    if (next) {
      lazy.LazyvimiumAgents.setDefaultAgent(next.id);
      conversation.setAgent(next);
    }
  }

  #send() {
    const conversation = this.#conversation;
    const text = this.#input.value.trim();
    if (!conversation || !text || conversation.running) {
      return;
    }
    this.#input.value = "";
    this.#fitInput();
    // The page takes focus while the agent types and presses keys in it;
    // the dock stays open, and <leader>aa comes back to it.
    if (this.#window.gBrowser.selectedBrowser == conversation.browser) {
      conversation.browser.focus();
    }
    conversation.send(text).catch(e => {
      console.error("Lazyvimium: the agent turn failed", e);
    });
  }

  #fitInput() {
    this.#input.style.height = "auto";
    this.#input.style.height = `${Math.min(this.#input.scrollHeight, 160)}px`;
  }

  #render() {
    const conversation = this.#conversation;
    const document = this.#window.document;
    const create = (tag, className, text) => {
      const element = document.createElementNS(HTML_NS, tag);
      element.className = className;
      if (text !== undefined) {
        element.textContent = text;
      }
      return element;
    };
    const atBottom =
      this.#log.scrollTop + this.#log.clientHeight >=
      this.#log.scrollHeight - 8;

    const rows = [];
    if (!conversation) {
      rows.push(...this.#renderNoAgent(create));
    }
    for (const message of conversation?.messages ?? []) {
      const row = create("div", "lazyvimium-agent-message");
      row.setAttribute("type", message.type);
      switch (message.type) {
        case "step": {
          row.setAttribute("status", message.status);
          row.append(
            create(
              "span",
              "lazyvimium-agent-step-icon",
              STEP_ICONS[message.status] ?? "·"
            ),
            create("span", "lazyvimium-agent-step-title", message.text)
          );
          if (message.detail) {
            row.append(
              create("span", "lazyvimium-agent-step-detail", message.detail)
            );
          }
          break;
        }
        case "tool":
          row.textContent = `used ${message.text}`;
          break;
        case "confirm": {
          row.setAttribute("status", message.status);
          row.append(
            create(
              "span",
              "",
              `Allow the agent to ${message.text.toLowerCase()}?`
            )
          );
          if (message.status == "pending") {
            const allow = create(
              "button",
              "lazyvimium-agent-button primary",
              "Allow  y"
            );
            const deny = create("button", "lazyvimium-agent-button", "Deny  n");
            allow.addEventListener("click", () => message.answer(true));
            deny.addEventListener("click", () => message.answer(false));
            row.append(allow, deny);
          } else {
            row.append(
              create("span", "lazyvimium-agent-step-detail", message.status)
            );
          }
          break;
        }
        default:
          row.textContent = message.text;
      }
      rows.push(row);
    }
    this.#log.replaceChildren(...rows);
    this.#log.hidden = !rows.length;
    if (atBottom) {
      this.#log.scrollTop = this.#log.scrollHeight;
    }

    const agent = conversation?.agent;
    this.#agentChip.textContent = agent ? agent.name : "No agent";
    this.#agentChip.style.setProperty(
      "--lazyvimium-agent-color",
      lazy.agentColor(agent?.id)
    );
    const browser =
      conversation?.browser ?? this.#window.gBrowser.selectedBrowser;
    this.#tabChip.textContent =
      browser.contentTitle || browser.currentURI?.spec || "";
    this.#input.disabled = !conversation;
    let placeholder = "";
    let hint =
      "Enter send · Shift+Enter new line · Tab switch agent · Esc close";
    if (conversation?.pendingConfirm) {
      hint = "y allow · n deny · Esc hide";
    } else if (conversation?.running) {
      placeholder = `${agent.name} is working on this tab…`;
      hint = "Ctrl+C stop · Esc hide, it keeps working";
    } else if (agent) {
      placeholder = `Ask ${agent.name} to do something on this tab`;
    }
    this.#input.placeholder = placeholder;
    this.#hint.textContent = hint;
    this.#root.toggleAttribute("running", !!conversation?.running);
    this.#updateStatus();
  }

  #renderNoAgent(create) {
    const rows = [
      create(
        "div",
        "lazyvimium-agent-message",
        "No coding agent found on this computer. lazyvimium works with the one you already use: install one, then look again."
      ),
    ];
    const list = create("div", "lazyvimium-agent-install");
    lazy.LazyvimiumAgents.agents().then(agents => {
      for (const agent of agents) {
        const row = create("div", "lazyvimium-agent-install-row");
        row.append(
          create("span", "lazyvimium-agent-install-name", agent.name),
          create("code", "", agent.install)
        );
        list.append(row);
      }
    });
    const again = create(
      "button",
      "lazyvimium-agent-button primary",
      "Look again"
    );
    again.addEventListener("click", async () => {
      await lazy.LazyvimiumAgents.agents({ refresh: true });
      this.open(this.#window.gBrowser.selectedBrowser);
    });
    rows.push(list, again);
    return rows;
  }

  #updateStatus() {
    const conversation = this.#conversation;
    const running = !!conversation?.running;
    this.#status.textContent = running
      ? `working · ${formatElapsed(Date.now() - conversation.startedAt)}`
      : "";
    if (running && !this.#timer) {
      this.#timer = this.#window.setInterval(() => {
        this.#updateStatus();
        this.#syncPill();
      }, 1000);
    } else if (!running && this.#timer) {
      this.#window.clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  // The pill under a closed dock, for the selected tab's conversation.
  #syncPill() {
    const conversation = lazy.LazyvimiumAgents.conversationFor(
      this.#window.gBrowser.selectedBrowser
    );
    const show = !this.#open && (conversation?.running || conversation?.unseen);
    this.#pill.hidden = !show;
    if (!show) {
      return;
    }
    this.#pill.style.setProperty(
      "--lazyvimium-agent-color",
      lazy.agentColor(conversation.agent.id)
    );
    this.#pill.toggleAttribute("running", conversation.running);
    this.#pill.textContent = conversation.running
      ? `${conversation.agent.name} is working · ${formatElapsed(Date.now() - conversation.startedAt)}`
      : `${conversation.agent.name} finished · open`;
  }
}
