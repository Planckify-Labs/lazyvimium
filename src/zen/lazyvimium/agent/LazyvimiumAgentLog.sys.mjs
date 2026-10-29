// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// A trace of each agent conversation, to see afterwards what the agent was
// told, what it saw and what went wrong: one JSON object per line in
// <profile>/lazyvimium/agent/logs/, with what the CLI printed, every MCP
// request, every browser tool call with the full text the agent got back,
// and how each turn ended. Tokens never reach it. With
// lazyvimium.agent.log.stdout on, a one-line summary of each entry also goes
// to the terminal the browser runs in.

export const PREF_LOG = "lazyvimium.agent.log.enabled";
export const PREF_LOG_STDOUT = "lazyvimium.agent.log.stdout";

// The newest logs kept; older ones go when a conversation starts.
const MAX_LOGS = 50;
const SUMMARY_LENGTH = 160;

function stamp(date) {
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function oneLine(value) {
  const text = typeof value == "string" ? value : JSON.stringify(value);
  const line = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > SUMMARY_LENGTH
    ? `${line.slice(0, SUMMARY_LENGTH)}…`
    : line;
}

// The terminal line for an entry: what happened, briefly. Null for what
// only the file needs: raw CLI output, and session ids agents repeat on
// every line.
export function summarize(entry) {
  switch (entry.kind) {
    case "turn":
      return `turn ${entry.turn} on ${entry.url}: ${oneLine(entry.request)}`;
    case "spawn":
      return `spawn ${entry.executable} (${entry.args.length} args)`;
    case "stdout":
      return null;
    case "event":
      if (entry.event.type == "session" || entry.event.type == "done") {
        return null;
      }
      return `${entry.event.type} ${oneLine(entry.event.text ?? entry.event.name ?? "")}`;
    case "done":
      return entry.error
        ? `turn FAILED after ${entry.ms}ms: ${oneLine(entry.error)}`
        : `turn done after ${entry.ms}ms`;
    case "tool":
      return `${entry.name} ${oneLine(entry.args)} → ${entry.isError ? "ERROR" : "ok"} ${entry.ms}ms ${oneLine(entry.title ?? "")}`;
    case "mcp":
      // OpenCode sends notifications/cancelled after every tool call.
      if (entry.method?.startsWith("notifications/") && !entry.error) {
        return null;
      }
      return `mcp ${entry.method}${entry.error ? ` ERROR ${entry.error}` : ""}`;
    case "stderr":
      return `stderr ${oneLine(entry.text)}`;
    case "exit":
      return `exit ${entry.exitCode ?? "-"} after ${entry.ms}ms${entry.error ? `: ${oneLine(entry.error)}` : ""}`;
    case "confirm":
      return `asked "${entry.question}": ${entry.allowed ? "allowed" : "declined"}`;
  }
  return `${entry.kind} ${oneLine(entry)}`;
}

export class LazyvimiumAgentLog {
  /** @type {string|null} Where the log is, or null when logging is off. */
  path = null;

  #secrets = new Set();
  #queue = Promise.resolve();
  #start = Date.now();
  #label;

  /**
   * @param {object} options
   * @param {string} options.dir The logs directory.
   * @param {string} options.agent The agent's id.
   */
  constructor({ dir, agent }) {
    this.#label = agent;
    if (!Services.prefs.getBoolPref(PREF_LOG, true)) {
      return;
    }
    const id = Math.random().toString(36).slice(2, 8);
    this.path = PathUtils.join(
      dir,
      `${stamp(new Date())}-${agent}-${id}.jsonl`
    );
    this.#queue = (async () => {
      await IOUtils.makeDirectory(dir, { permissions: 0o700 });
      await IOUtils.writeUTF8(this.path, "");
      await IOUtils.setPermissions(this.path, 0o600);
      await LazyvimiumAgentLog.prune(dir);
    })().catch(e => {
      console.error("Lazyvimium: could not start the agent log", e);
      this.path = null;
    });
  }

  /**
   * Keep a value, such as a run's token, out of the log.
   *
   * @param {string} secret
   */
  hide(secret) {
    if (secret) {
      this.#secrets.add(secret);
    }
  }

  /**
   * Add an entry.
   *
   * @param {string} kind
   * @param {object} [data]
   */
  write(kind, data = {}) {
    // `at` is when, in ms since the conversation started; `ms` in an entry
    // is always how long something took.
    const entry = {
      t: new Date().toISOString(),
      at: Date.now() - this.#start,
      kind,
      ...data,
    };
    let line = JSON.stringify(entry);
    for (const secret of this.#secrets) {
      line = line.replaceAll(secret, "<token>");
    }
    let summary = Services.prefs.getBoolPref(PREF_LOG_STDOUT, false)
      ? summarize(entry)
      : null;
    if (summary) {
      for (const secret of this.#secrets) {
        summary = summary.replaceAll(secret, "<token>");
      }
      dump(`[lazyvimium:${this.#label}] ${summary}\n`);
    }
    if (!this.path) {
      return;
    }
    this.#queue = this.#queue
      .then(
        () =>
          this.path &&
          IOUtils.writeUTF8(this.path, `${line}\n`, { mode: "append" })
      )
      .catch(e =>
        console.error("Lazyvimium: could not write the agent log", e)
      );
  }

  /** Resolves once every entry so far is on disk. */
  flush() {
    return this.#queue;
  }

  /**
   * Remove all but the newest logs.
   *
   * @param {string} dir
   */
  static async prune(dir) {
    const logs = (await IOUtils.getChildren(dir))
      .filter(path => path.endsWith(".jsonl"))
      .sort();
    for (const path of logs.slice(0, -MAX_LOGS)) {
      await IOUtils.remove(path).catch(() => {});
    }
  }
}
