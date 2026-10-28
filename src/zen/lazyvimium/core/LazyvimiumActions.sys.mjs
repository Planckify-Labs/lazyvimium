// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Every feature is an action with an id. Keymaps, the command line,
// which-key and agent tools only ever refer to actions by id, so a feature
// written once is reachable from all of them.

/**
 * Where an action runs: in the parent process with the browser window
 * (tabs, spaces, split view), or in the content process with the page
 * (scrolling, hints, reading).
 *
 * @typedef {"parent"|"content"} LazyvimiumActionSide
 */

/**
 * How an agent may use an action. false keeps it away from agents; "read"
 * and "act" are offered freely within the session's policy; "confirm"
 * always asks the user first.
 *
 * @typedef {false|"read"|"act"|"confirm"} LazyvimiumAgentAccess
 */

/**
 * @typedef {object} LazyvimiumActionDefinition
 * @property {string} desc One line, shown in which-key and pickers.
 * @property {(context: object, args: object) => *} [run] Does the work for a
 *   parent action; may return a value or a promise.
 * @property {string} [module] For a content action: the module, loaded in
 *   the content process, whose `actions` export maps this id to its
 *   implementation. Content actions run next to the page so that held keys
 *   (j, k) never wait on a round trip to the parent.
 * @property {LazyvimiumActionSide} [where] Defaults to "parent".
 * @property {Record<string, string>} [params] Argument types, e.g.
 *   `{ count: "number?", url: "string" }`. A trailing "?" marks an optional
 *   argument. Types: string, number, boolean, object, array.
 * @property {LazyvimiumAgentAccess} [agent] Defaults to false.
 */

const PARAM_TYPES = new Set(["string", "number", "boolean", "object", "array"]);
const SIDES = new Set(["parent", "content"]);
const AGENT_ACCESS = new Set([false, "read", "act", "confirm"]);
// Action ids are dotted lowercase words: "tabs.next", "scroll.halfPageDown".
const ID_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

export class LazyvimiumActionError extends Error {
  /**
   * @param {"unknown-action"|"invalid-action"|"invalid-args"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "LazyvimiumActionError";
    this.code = code;
  }
}

function parseParamType(spec) {
  const optional = spec.endsWith("?");
  const type = optional ? spec.slice(0, -1) : spec;
  return { type, optional };
}

function typeOf(value) {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

/**
 * The action list. One registry exists per process; plugins register into
 * it through the plugin loader, which tags each action with its plugin.
 */
export class LazyvimiumActions {
  /** @type {Map<string, LazyvimiumActionDefinition & {id: string, owner?: string}>} */
  #actions = new Map();

  /**
   * Add or replace an action.
   *
   * @param {string} id
   * @param {LazyvimiumActionDefinition} definition
   * @param {object} [options]
   * @param {string} [options.owner] The plugin registering it.
   */
  register(id, definition, { owner } = {}) {
    if (!ID_PATTERN.test(id)) {
      throw new LazyvimiumActionError(
        "invalid-action",
        `Lazyvimium: "${id}" is not a valid action id (use "group.name")`
      );
    }
    const {
      desc,
      run,
      module,
      where = "parent",
      params = {},
      agent = false,
    } = definition ?? {};
    if (typeof desc != "string" || !desc) {
      throw new LazyvimiumActionError(
        "invalid-action",
        `Lazyvimium: action "${id}" needs a desc`
      );
    }
    if (!SIDES.has(where)) {
      throw new LazyvimiumActionError(
        "invalid-action",
        `Lazyvimium: action "${id}" has an unknown where "${where}"`
      );
    }
    if (where == "parent" && typeof run != "function") {
      throw new LazyvimiumActionError(
        "invalid-action",
        `Lazyvimium: action "${id}" needs a run function`
      );
    }
    if (where == "content" && (typeof module != "string" || run)) {
      throw new LazyvimiumActionError(
        "invalid-action",
        `Lazyvimium: content action "${id}" needs a module and no run function`
      );
    }
    if (!AGENT_ACCESS.has(agent)) {
      throw new LazyvimiumActionError(
        "invalid-action",
        `Lazyvimium: action "${id}" has an unknown agent access "${agent}"`
      );
    }
    for (const [name, spec] of Object.entries(params)) {
      if (
        typeof spec != "string" ||
        !PARAM_TYPES.has(parseParamType(spec).type)
      ) {
        throw new LazyvimiumActionError(
          "invalid-action",
          `Lazyvimium: action "${id}" has an unknown type for "${name}"`
        );
      }
    }
    this.#actions.set(id, {
      id,
      desc,
      run,
      module,
      where,
      params,
      agent,
      owner,
    });
  }

  /**
   * @param {string} id
   */
  unregister(id) {
    this.#actions.delete(id);
  }

  /**
   * Remove every action a plugin registered.
   *
   * @param {string} owner
   */
  removeOwner(owner) {
    for (const [id, action] of this.#actions) {
      if (action.owner == owner) {
        this.#actions.delete(id);
      }
    }
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  has(id) {
    return this.#actions.has(id);
  }

  /**
   * @param {string} id
   */
  get(id) {
    return this.#actions.get(id) ?? null;
  }

  /**
   * @param {object} [filter]
   * @param {string} [filter.owner]
   * @param {boolean} [filter.agent] Only actions agents may use.
   */
  list({ owner, agent } = {}) {
    return [...this.#actions.values()].filter(
      action =>
        (owner === undefined || action.owner == owner) &&
        (!agent || action.agent !== false)
    );
  }

  /**
   * Check arguments against an action's params. Unknown arguments are
   * rejected, since agent tool calls arrive through here too.
   *
   * @param {string} id
   * @param {object} [args]
   * @returns {object} The arguments.
   */
  validate(id, args = {}) {
    const action = this.#require(id);
    if (typeOf(args) != "object") {
      throw new LazyvimiumActionError(
        "invalid-args",
        `Lazyvimium: arguments for "${id}" must be an object`
      );
    }
    for (const name of Object.keys(args)) {
      if (!(name in action.params)) {
        throw new LazyvimiumActionError(
          "invalid-args",
          `Lazyvimium: "${id}" does not take "${name}"`
        );
      }
    }
    for (const [name, spec] of Object.entries(action.params)) {
      const { type, optional } = parseParamType(spec);
      const value = args[name];
      if (value === undefined || value === null) {
        if (!optional) {
          throw new LazyvimiumActionError(
            "invalid-args",
            `Lazyvimium: "${id}" needs "${name}"`
          );
        }
        continue;
      }
      if (
        typeOf(value) != type ||
        (type == "number" && !Number.isFinite(value))
      ) {
        throw new LazyvimiumActionError(
          "invalid-args",
          `Lazyvimium: "${name}" for "${id}" must be a ${type}`
        );
      }
    }
    return args;
  }

  /**
   * Validate the arguments and run a parent action. A content action is
   * handed to `context.runContent(action, args)`, which forwards it to the
   * page it should act on.
   *
   * @param {string} id
   * @param {object} context What the action works on (the window, the
   *   plugin's options, and runContent for content actions).
   * @param {object} [args]
   * @returns {Promise<*>}
   */
  async run(id, context, args = {}) {
    const action = this.#require(id);
    this.validate(id, args);
    if (action.where == "content") {
      if (typeof context?.runContent != "function") {
        throw new LazyvimiumActionError(
          "invalid-action",
          `Lazyvimium: content action "${id}" has no page to run in`
        );
      }
      return context.runContent(action, args);
    }
    return action.run(context, args);
  }

  /**
   * The JSON Schema for an action's arguments, used to describe it as an
   * agent tool.
   *
   * @param {string} id
   * @returns {object}
   */
  schema(id) {
    const action = this.#require(id);
    const properties = {};
    const required = [];
    for (const [name, spec] of Object.entries(action.params)) {
      const { type, optional } = parseParamType(spec);
      properties[name] = { type };
      if (!optional) {
        required.push(name);
      }
    }
    return {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    };
  }

  #require(id) {
    const action = this.#actions.get(id);
    if (!action) {
      throw new LazyvimiumActionError(
        "unknown-action",
        `Lazyvimium: there is no action "${id}"`
      );
    }
    return action;
  }
}
