// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Running the user's own coding agent for one turn, after zeron's harness
// drivers: each agent's CLI runs headless with its JSON event stream on
// stdout, and lazyvimium's MCP server added to its config so the agent gets
// the browser tools. The user's login, model and settings stay the agent's
// own. A driver only knows its CLI's command line and event shapes; the run
// below is the same for every agent.

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
});

export const MCP_SERVER_NAME = "lazyvimium";
// Agents that read their MCP config from a file are given the token through
// this variable, so it is never written to disk or seen in `ps`.
export const TOKEN_ENV = "LAZYVIMIUM_MCP_TOKEN";
export const URL_ENV = "LAZYVIMIUM_MCP_URL";

// lazyvimium-mcp: the browser's MCP server over stdio, for agents that only
// start servers as commands. Each JSON-RPC line is POSTed to the server, and
// the token reaches curl through a file descriptor, never its command line.
export const STDIO_PROXY = `[ -n "$${URL_ENV}" ] && [ -n "$${TOKEN_ENV}" ] || exit 0
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] || continue
  out=$(printf '%s' "$line" | curl -sS --max-time 900 -K /dev/fd/3 --data-binary @- "$${URL_ENV}" 3<<EOF
header = "Authorization: Bearer $${TOKEN_ENV}"
header = "Content-Type: application/json"
header = "Accept: application/json, text/event-stream"
EOF
)
  [ -n "$out" ] && printf '%s\\n' "$out"
done`;

// The browser tools, whose calls the panel shows itself from the server's
// side; the agents' own reports of them are skipped.
const OWN_TOOLS = [
  "page_observe",
  "page_act",
  "page_navigate",
  "browser_action",
];

// Agents' plumbing rather than work: Claude Code loads deferred tools,
// lazyvimium's among them, through ToolSearch, and agy reports every MCP
// call, lazyvimium's included, as call_mcp_tool.
const QUIET_TOOLS = new Set(["ToolSearch", "call_mcp_tool"]);

const STDERR_TAIL = 4000;

export const BROWSER_INSTRUCTIONS = `You are working in the user's web browser, lazyvimium, on the tab they asked from. Use the "${MCP_SERVER_NAME}" tools to do what they ask:
- page_observe reads the tab: its address, the visible text and the controls you can use, each with an id like e12.
- page_act clicks, fills, selects, presses a key or scrolls, using an id from the latest observation, and returns the page after the action.
- page_navigate opens an address; browser_action runs a browser command (tabs, history, reader mode and more).
Observe before you act. Ids stay valid only while the element is unchanged; if a call says the page changed, observe again. Do not use shell, file or code tools for the task. Never enter passwords or payment details: ask the user to do that. When you are done, answer in a few sentences.`;

function ownTool(name) {
  return typeof name == "string" && OWN_TOOLS.some(tool => name.endsWith(tool));
}

function toolEvent(name, input) {
  return ownTool(name) || QUIET_TOOLS.has(name)
    ? []
    : [{ type: "tool", name: String(name), input }];
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

/**
 * @typedef {object} LazyvimiumAgentTurn
 * @property {string} prompt What to send, with the tab's context.
 * @property {string|null} resume The agent's session id from the previous
 *   turn of this conversation.
 * @property {boolean} first Whether this is the conversation's first turn.
 * @property {{url: string, token: string}} mcp The browser's MCP server.
 * @property {string} dir The agent's working directory, private to the
 *   user, where config files go.
 * @property {string} runId Unique per turn, naming its private files.
 */

/**
 * @typedef {object} LazyvimiumAgentEvent
 * @property {"session"|"text"|"tool"|"done"} type What happened.
 * @property {string} [id] For session: the agent's id to resume.
 * @property {string} [text] For text.
 * @property {boolean} [delta] For text: a piece of the current message.
 * @property {string} [name] For tool: one of the agent's own tools.
 * @property {*} [input] For tool: what the agent passed it.
 * @property {string|null} [error] For done.
 */

// The prompt for agents without a system prompt flag: the instructions go
// in front of the first turn.
function withInstructions(turn) {
  return turn.first ? `${BROWSER_INSTRUCTIONS}\n\n${turn.prompt}` : turn.prompt;
}

function textBlocks(content) {
  if (typeof content == "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  return (Array.isArray(content) ? content : []).flatMap(block => {
    if (block?.type == "text" && block.text) {
      return [{ type: "text", text: block.text }];
    }
    if (block?.type == "tool_use") {
      return toolEvent(block.name, block.input);
    }
    return [];
  });
}

// Claude Code and Cursor's agent print the same stream-json shapes.
function parseStreamJson(event) {
  switch (event.type) {
    case "system":
      return event.subtype == "init" && event.session_id
        ? [{ type: "session", id: event.session_id }]
        : [];
    case "assistant":
      return textBlocks(event.message?.content);
    case "tool_call":
      if (event.subtype != "started") {
        return [];
      }
      return Object.entries(event.tool_call ?? {}).flatMap(([kind, call]) =>
        toolEvent(call?.args?.name ?? kind.replace(/ToolCall$/, ""), call?.args)
      );
    case "result":
      return [
        ...(event.session_id
          ? [{ type: "session", id: event.session_id }]
          : []),
        {
          type: "done",
          error: event.is_error
            ? String(event.result || event.subtype || "The agent failed")
            : null,
        },
      ];
  }
  return [];
}

/**
 * The drivers, by agent id. `launch` returns the command line, extra
 * environment and private files of a turn; `parse` turns one JSON line of
 * output into events.
 */
export const LAZYVIMIUM_DRIVERS = {
  claude: {
    launch(turn) {
      const config = PathUtils.join(turn.dir, `claude-mcp-${turn.runId}.json`);
      return {
        args: [
          "--print",
          turn.prompt,
          "--output-format",
          "stream-json",
          "--verbose",
          "--mcp-config",
          config,
          "--allowedTools",
          `mcp__${MCP_SERVER_NAME}`,
          "--append-system-prompt",
          BROWSER_INSTRUCTIONS,
          ...(turn.resume ? ["--resume", turn.resume] : []),
        ],
        files: [
          {
            path: config,
            data: {
              mcpServers: {
                [MCP_SERVER_NAME]: {
                  type: "http",
                  url: turn.mcp.url,
                  headers: { Authorization: `Bearer ${turn.mcp.token}` },
                },
              },
            },
            temporary: true,
          },
        ],
      };
    },
    parse: parseStreamJson,
  },

  codex: {
    launch(turn) {
      const server = `mcp_servers.${MCP_SERVER_NAME}`;
      return {
        args: [
          "-c",
          `${server}.url=${tomlString(turn.mcp.url)}`,
          "-c",
          `${server}.bearer_token_env_var=${tomlString(TOKEN_ENV)}`,
          "-c",
          `${server}.default_tools_approval_mode="approve"`,
          "-c",
          `sandbox_mode="read-only"`,
          "exec",
          ...(turn.resume ? ["resume"] : []),
          "--json",
          "--skip-git-repo-check",
          ...(turn.resume ? [turn.resume] : []),
          withInstructions(turn),
        ],
      };
    },
    parse(event) {
      switch (event.type) {
        case "thread.started":
          return event.thread_id
            ? [{ type: "session", id: event.thread_id }]
            : [];
        case "item.completed": {
          const item = event.item ?? {};
          switch (item.type) {
            case "agent_message":
              return item.text ? [{ type: "text", text: item.text }] : [];
            case "command_execution":
              return toolEvent("shell", item.command);
            case "web_search":
              return toolEvent("web_search", item.query);
            case "mcp_tool_call":
              return item.server == MCP_SERVER_NAME
                ? []
                : toolEvent(`${item.server}.${item.tool}`, item.arguments);
          }
          return [];
        }
        case "turn.completed":
          return [{ type: "done", error: null }];
        case "turn.failed":
          return [
            {
              type: "done",
              error: String(event.error?.message ?? "The agent failed"),
            },
          ];
      }
      return [];
    },
  },

  cursor: {
    launch(turn) {
      return {
        args: [
          "--print",
          "--output-format",
          "stream-json",
          "--approve-mcps",
          "--trust",
          ...(turn.resume ? ["--resume", turn.resume] : []),
          withInstructions(turn),
        ],
        files: [
          {
            path: PathUtils.join(turn.dir, ".cursor", "mcp.json"),
            data: {
              mcpServers: {
                [MCP_SERVER_NAME]: {
                  url: turn.mcp.url,
                  headers: { Authorization: `Bearer \${env:${TOKEN_ENV}}` },
                },
              },
            },
          },
        ],
      };
    },
    parse: parseStreamJson,
  },

  // Antigravity's agy reads MCP servers from its global config only, and
  // expands no variables in it, so it gets the stdio proxy instead (see
  // ensureConnected below), which reads the address and token from the
  // environment of each run.
  antigravity: {
    launch(turn) {
      return {
        args: [
          "--print",
          withInstructions(turn),
          "--output-format",
          "stream-json",
          "--dangerously-skip-permissions",
          ...(turn.resume ? ["--conversation", turn.resume] : []),
        ],
      };
    },
    parse(event) {
      switch (event.event) {
        case "init":
          return event.conversation_id
            ? [{ type: "session", id: event.conversation_id }]
            : [];
        case "step_update": {
          const step = event.step_update ?? {};
          if (step.step_type == "agent_response" && step.text_delta) {
            return [{ type: "text", text: step.text_delta, delta: true }];
          }
          if (step.state == "ACTIVE" && step.tool_name) {
            return toolEvent(step.tool_name, step.tool_input);
          }
          return [];
        }
        case "result": {
          const result = event.result ?? {};
          return [
            {
              type: "done",
              error:
                result.status && result.status != "SUCCESS"
                  ? String(result.error ?? result.response ?? result.status)
                  : null,
            },
          ];
        }
      }
      return [];
    },
    /**
     * Add lazyvimium to agy's MCP servers once. The entry holds no secret:
     * outside a lazyvimium run the proxy finds no address and exits.
     *
     * @param {(args: string[]) => Promise<{stdout: string, exitCode: number|null}>} agy
     * @returns {Promise<boolean>} Whether it is connected.
     */
    async ensureConnected(agy) {
      const { stdout } = await agy(["mcp", "list"]);
      if (new RegExp(`^${MCP_SERVER_NAME}\\s`, "m").test(stdout)) {
        return true;
      }
      const { exitCode } = await agy([
        "mcp",
        "add",
        MCP_SERVER_NAME,
        "--",
        "/bin/sh",
        "-c",
        STDIO_PROXY,
      ]);
      return exitCode === 0;
    },
  },

  opencode: {
    launch(turn) {
      const config = PathUtils.join(turn.dir, "opencode.json");
      return {
        args: [
          "run",
          "--format",
          "json",
          ...(turn.resume ? ["--session", turn.resume] : []),
          withInstructions(turn),
        ],
        env: { OPENCODE_CONFIG: config },
        files: [
          {
            path: config,
            data: {
              mcp: {
                [MCP_SERVER_NAME]: {
                  type: "remote",
                  url: turn.mcp.url,
                  headers: { Authorization: `Bearer {env:${TOKEN_ENV}}` },
                  enabled: true,
                },
              },
              // On a tab the agent works through the browser: no shell and
              // no file edits, which OpenCode otherwise runs unasked (in dev
              // testing it fell back to yt-dlp). Web search and fetch stay.
              tools: { bash: false, edit: false, write: false, patch: false },
              permission: { bash: "deny", edit: "deny" },
            },
          },
        ],
      };
    },
    parse(event) {
      const session = event.sessionID
        ? [{ type: "session", id: event.sessionID }]
        : [];
      switch (event.type) {
        case "text":
          return event.part?.text
            ? [...session, { type: "text", text: event.part.text }]
            : session;
        case "tool_use":
          return [
            ...session,
            ...toolEvent(event.part?.tool, event.part?.state?.input),
          ];
        case "error":
          return [
            {
              type: "done",
              error: String(
                event.error?.data?.message ??
                  event.error?.name ??
                  "The agent failed"
              ),
            },
          ];
      }
      return session;
    },
  },
};

/**
 * Write a file only the user can read: created empty, made private, then
 * filled in place.
 *
 * @param {string} path
 * @param {object} data
 */
async function writePrivateJSON(path, data) {
  await IOUtils.makeDirectory(PathUtils.parent(path), {
    permissions: 0o700,
  });
  await IOUtils.writeUTF8(path, "");
  await IOUtils.setPermissions(path, 0o600);
  await IOUtils.writeUTF8(path, JSON.stringify(data, null, 2));
}

/**
 * One turn of an agent: the process, its events and how it ended.
 */
export class LazyvimiumAgentRun {
  #proc = null;
  #stopped = false;
  #exited = false;
  #finished = false;
  #stderr = "";
  #temporary = [];
  #onEvent;
  #log;
  #startedAt = 0;
  #done = Promise.withResolvers();

  /**
   * @param {object} options
   * @param {object} options.driver One of LAZYVIMIUM_DRIVERS.
   * @param {string} options.executable
   * @param {LazyvimiumAgentTurn} options.turn
   * @param {string} options.path The PATH to start it with.
   * @param {(event: LazyvimiumAgentEvent) => void} options.onEvent
   * @param {object} [options.log] A LazyvimiumAgentLog for the conversation.
   */
  constructor({ driver, executable, turn, path, onEvent, log = null }) {
    this.driver = driver;
    this.executable = executable;
    this.turn = turn;
    this.path = path;
    this.#onEvent = onEvent;
    this.#log = log;
    log?.hide(turn.mcp.token);
  }

  /** Resolves with the error, or null, once the turn is over. */
  get done() {
    return this.#done.promise;
  }

  async start() {
    const { args, env = {}, files = [] } = this.driver.launch(this.turn);
    this.#startedAt = Date.now();
    this.#log?.write("spawn", {
      executable: this.executable,
      args,
      cwd: this.turn.dir,
      env: Object.keys(env),
      files: files.map(file => file.path),
    });
    try {
      await IOUtils.makeDirectory(this.turn.dir, { permissions: 0o700 });
      for (const file of files) {
        await writePrivateJSON(file.path, file.data);
        if (file.temporary) {
          this.#temporary.push(file.path);
        }
      }
      const environment = lazy.Subprocess.getEnvironment();
      // A browser started from inside an agent's terminal must not make the
      // agent it runs think it is nested in itself.
      for (const name of Object.keys(environment)) {
        if (name == "CLAUDECODE" || name.startsWith("CLAUDE_CODE_")) {
          delete environment[name];
        }
      }
      Object.assign(environment, env, {
        PATH: this.path,
        [URL_ENV]: this.turn.mcp.url,
        [TOKEN_ENV]: this.turn.mcp.token,
        NO_COLOR: "1",
      });
      this.#proc = await lazy.Subprocess.call({
        command: this.executable,
        arguments: args,
        environment,
        environmentAppend: false,
        workdir: this.turn.dir,
        stderr: "pipe",
      });
    } catch (e) {
      const error = `Could not start ${this.executable}: ${e.message ?? e}`;
      this.#log?.write("exit", { exitCode: null, error, ms: 0 });
      this.#finish(error);
      return;
    }
    if (this.#stopped) {
      this.#proc.kill(0).catch(() => {});
    }
    this.#proc.stdin.close().catch(() => {});
    this.#readStderr();
    this.#readStdout();
  }

  stop() {
    this.#stopped = true;
    if (!this.#exited) {
      this.#proc?.kill(2000).catch(() => {});
    }
  }

  async #readStdout() {
    let buffer = "";
    try {
      let chunk;
      while ((chunk = await this.#proc.stdout.readString())) {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) != -1) {
          this.#line(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      }
      this.#line(buffer);
    } catch (e) {
      console.error("Lazyvimium: reading the agent failed", e);
    }
    const { exitCode } = await this.#proc.wait().catch(() => ({
      exitCode: -1,
    }));
    this.#exited = true;
    this.#log?.write("exit", {
      exitCode,
      stopped: this.#stopped,
      ms: Date.now() - this.#startedAt,
    });
    if (this.#stopped) {
      this.#finish("Stopped");
    } else if (exitCode) {
      const tail = this.#stderr.trim().split("\n").slice(-6).join("\n");
      this.#finish(tail || `The agent exited with code ${exitCode}`);
    } else {
      this.#finish(null);
    }
  }

  async #readStderr() {
    try {
      let chunk;
      while ((chunk = await this.#proc.stderr.readString())) {
        this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL);
        this.#log?.write("stderr", { text: chunk });
      }
    } catch {
      // The process is gone.
    }
  }

  #line(line) {
    line = line.trim();
    if (!line) {
      return;
    }
    // Everything the CLI printed, parsed or not: a shape the driver does
    // not know shows up here.
    this.#log?.write("stdout", { line });
    if (!line.startsWith("{")) {
      return;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    for (const parsed of this.driver.parse(event)) {
      this.#log?.write("event", { event: parsed });
      if (parsed.type == "done") {
        this.#finish(parsed.error ?? null);
      } else if (!this.#finished) {
        this.#onEvent(parsed);
      }
    }
  }

  #finish(error) {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    for (const path of this.#temporary) {
      IOUtils.remove(path).catch(() => {});
    }
    this.#onEvent({ type: "done", error });
    this.#done.resolve(error);
  }
}
