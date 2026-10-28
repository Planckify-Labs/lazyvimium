// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Plugin specs in the style of lazy.nvim and LazyVim. A feature is a spec:
//
//   {
//     name: "tabs",
//     opts: { wrap: true },
//     actions: (plugin, opts) => ({
//       "tabs.next": { desc: "Next Tab", run: ctx => ... },
//     }),
//     keys: [["n", "<S-l>", "tabs.next", { desc: "Next Tab" }]],
//     groups: [["n", "<leader>b", "buffer"]],
//   }
//
// Several specs may share a name: core defaults, then extras, then the
// user's overrides. They merge the way lazy.nvim merges specs: plain fields
// are replaced, opts tables are deep merged (or transformed by a function),
// actions merge by id, keys are appended and `false` as the rhs removes one.
// Heavy code is not loaded here: an action imports what it needs when it
// first runs.

import { LazyvimiumKeys } from "resource:///modules/lazyvimium/core/LazyvimiumKeys.sys.mjs";

// LazyVim's default extra priority. Lower loads first.
const DEFAULT_PRIORITY = 50;

const SPEC_FIELDS = new Set([
  "name",
  "enabled",
  "extra",
  "priority",
  "opts",
  "actions",
  "keys",
  "groups",
  "setup",
]);

function isPlainObject(value) {
  if (typeof value != "object" || value === null) {
    return false;
  }
  // Specs come from other globals (tests, the user's JSON), whose
  // Object.prototype is not this module's.
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/**
 * Merge plain objects recursively; anything else in `source` replaces what is
 * in `target`, arrays included (as vim.tbl_deep_extend does).
 *
 * @param {object} target
 * @param {object} source
 * @returns {object} A new object.
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    result[key] =
      isPlainObject(value) && isPlainObject(result[key])
        ? deepMerge(result[key], value)
        : value;
  }
  return result;
}

/**
 * Normalize a key entry: `[modes, lhs, rhs, { desc }]` or
 * `{ mode, lhs, rhs, desc }`.
 *
 * @param {Array|object} entry
 * @returns {object}
 */
function normalizeKey(entry) {
  if (Array.isArray(entry)) {
    const [mode, lhs, rhs, options = {}] = entry;
    return { ...options, mode, lhs, rhs };
  }
  if (isPlainObject(entry)) {
    return { ...entry };
  }
  throw new Error("Lazyvimium: a key entry must be an array or an object");
}

/**
 * Normalize a group entry: `[modes, lhs, name]` or `{ mode, lhs, name }`.
 *
 * @param {Array|object} entry
 * @returns {object}
 */
function normalizeGroup(entry) {
  if (Array.isArray(entry)) {
    const [mode, lhs, name] = entry;
    return { mode, lhs, name };
  }
  if (isPlainObject(entry)) {
    return { ...entry };
  }
  throw new Error("Lazyvimium: a group entry must be an array or an object");
}

/**
 * @typedef {object} LazyvimiumPlugin
 * @property {string} name Unique; specs with the same name merge.
 * @property {boolean} extra Loads only when listed in the enabled extras.
 * @property {number} priority Lower loads first; defaults to 50.
 * @property {boolean} enabled Whether the last load() wanted it.
 * @property {boolean} loaded Whether its actions and keys are registered.
 * @property {object} opts The resolved options, once loaded.
 * @property {Error|null} error Why the plugin failed to load.
 * @property {string[]} warnings Problems that did not stop it loading.
 */

export class LazyvimiumPlugins {
  #actions;
  #keymap;
  /** @type {Map<string, LazyvimiumPlugin>} */
  #plugins = new Map();

  /**
   * @param {object} options
   * @param {import("resource:///modules/lazyvimium/core/LazyvimiumActions.sys.mjs").LazyvimiumActions} options.actions
   * @param {import("resource:///modules/lazyvimium/core/LazyvimiumKeymap.sys.mjs").LazyvimiumKeymap} options.keymap
   */
  constructor({ actions, keymap }) {
    this.#actions = actions;
    this.#keymap = keymap;
  }

  /**
   * Merge and load specs. Plugins that are already loaded are unloaded first,
   * so calling this again with a changed list (an extra switched on, the
   * user's overrides edited) leaves the registry matching the new list.
   *
   * @param {object} options
   * @param {object[]} options.specs Core and extra specs.
   * @param {Iterable<string>} [options.extras] Names of the enabled extras.
   * @param {object[]} [options.overrides] The user's specs, merged last.
   * @returns {{loaded: string[], skipped: string[], failed: string[], invalid: Error[]}}
   */
  load({ specs, extras = [], overrides = [] }) {
    for (const name of this.#plugins.keys()) {
      this.unload(name);
    }
    this.#plugins.clear();

    const enabledExtras = new Set(extras);
    const { merged, invalid } = this.#merge([...specs, ...overrides]);
    const report = { loaded: [], skipped: [], failed: [], invalid };

    const candidates = [];
    for (const [name, { fragments, error }] of merged) {
      const plugin = {
        name,
        extra: false,
        priority: DEFAULT_PRIORITY,
        enabled: true,
        loaded: false,
        opts: {},
        error: null,
        warnings: [],
      };
      this.#plugins.set(name, plugin);
      try {
        if (error) {
          throw error;
        }
        this.#resolveFlags(plugin, fragments, enabledExtras);
      } catch (e) {
        plugin.error = e;
        report.failed.push(name);
        continue;
      }
      if (!plugin.enabled) {
        report.skipped.push(name);
        continue;
      }
      candidates.push({ plugin, fragments });
    }

    // Array.prototype.sort is stable: equal priorities keep spec order.
    candidates.sort((a, b) => a.plugin.priority - b.plugin.priority);
    for (const { plugin, fragments } of candidates) {
      try {
        this.#loadPlugin(plugin, fragments);
        plugin.loaded = true;
        report.loaded.push(plugin.name);
      } catch (e) {
        // Leave nothing half registered.
        this.#actions.removeOwner(plugin.name);
        this.#keymap.removeOwner(plugin.name);
        plugin.error = e;
        report.failed.push(plugin.name);
        console.error(`Lazyvimium: plugin "${plugin.name}" failed to load`, e);
      }
    }
    return report;
  }

  /**
   * Remove a plugin's actions, keys and groups.
   *
   * @param {string} name
   */
  unload(name) {
    const plugin = this.#plugins.get(name);
    if (!plugin?.loaded) {
      return;
    }
    this.#actions.removeOwner(name);
    this.#keymap.removeOwner(name);
    plugin.loaded = false;
  }

  /**
   * @param {string} name
   * @returns {LazyvimiumPlugin|null}
   */
  get(name) {
    return this.#plugins.get(name) ?? null;
  }

  /**
   * @returns {LazyvimiumPlugin[]} Every plugin seen by the last load(),
   *   including disabled and failed ones (for the health page).
   */
  list() {
    return [...this.#plugins.values()];
  }

  /**
   * Group spec fragments by name, keeping first-seen order. A malformed
   * fragment fails only its own plugin, so a typo in the user's overrides
   * does not take everything else down.
   *
   * @param {object[]} specs
   * @returns {{merged: Map<string, {fragments: object[], error: Error|null}>, invalid: Error[]}}
   */
  #merge(specs) {
    const merged = new Map();
    const invalid = [];
    for (const spec of specs) {
      if (!isPlainObject(spec) || typeof spec.name != "string" || !spec.name) {
        invalid.push(new Error("Lazyvimium: every plugin spec needs a name"));
        continue;
      }
      if (!merged.has(spec.name)) {
        merged.set(spec.name, { fragments: [], error: null });
      }
      const entry = merged.get(spec.name);
      const unknown = Object.keys(spec).filter(key => !SPEC_FIELDS.has(key));
      if (unknown.length) {
        entry.error ??= new Error(
          `Lazyvimium: plugin "${spec.name}" has unknown fields: ${unknown.join(", ")}`
        );
      }
      entry.fragments.push(spec);
    }
    return { merged, invalid };
  }

  #resolveFlags(plugin, fragments, enabledExtras) {
    let enabled = true;
    // A field set to undefined counts as not set.
    for (const fragment of fragments) {
      if (fragment.extra !== undefined) {
        plugin.extra = !!fragment.extra;
      }
      if (fragment.priority !== undefined) {
        if (!Number.isFinite(fragment.priority)) {
          throw new Error(
            `Lazyvimium: plugin "${plugin.name}" has a non-numeric priority`
          );
        }
        plugin.priority = fragment.priority;
      }
      if (fragment.enabled !== undefined) {
        enabled = fragment.enabled;
      }
    }
    if (typeof enabled == "function") {
      enabled = enabled(plugin);
    }
    plugin.enabled =
      !!enabled && (!plugin.extra || enabledExtras.has(plugin.name));
  }

  #loadPlugin(plugin, fragments) {
    let opts = {};
    for (const { opts: value } of fragments) {
      if (typeof value == "function") {
        opts = value(plugin, opts) ?? opts;
      } else if (isPlainObject(value)) {
        opts = deepMerge(opts, value);
      } else if (value !== undefined) {
        throw new Error(
          `Lazyvimium: opts for "${plugin.name}" must be an object or a function`
        );
      }
    }
    plugin.opts = opts;

    const actions = {};
    for (const { actions: value } of fragments) {
      const resolved = typeof value == "function" ? value(plugin, opts) : value;
      if (resolved !== undefined) {
        Object.assign(actions, resolved);
      }
    }
    for (const [id, definition] of Object.entries(actions)) {
      // `false` removes an action an earlier spec defined.
      if (definition !== false) {
        this.#actions.register(id, definition, { owner: plugin.name });
      }
    }

    let keys = [];
    for (const { keys: value } of fragments) {
      if (typeof value == "function") {
        keys = value(plugin, keys) ?? keys;
      } else if (Array.isArray(value)) {
        keys = keys.concat(value);
      } else if (value !== undefined) {
        throw new Error(
          `Lazyvimium: keys for "${plugin.name}" must be an array or a function`
        );
      }
    }
    // The last entry for a mode and sequence wins; `false` removes it.
    const finalKeys = new Map();
    for (const key of keys.map(normalizeKey)) {
      const modes = Array.isArray(key.mode) ? key.mode : [key.mode ?? "n"];
      const sequence = LazyvimiumKeys.sequenceKey(
        LazyvimiumKeys.parse(key.lhs, { leader: this.#keymap.leader })
      );
      for (const mode of modes) {
        finalKeys.set(`${mode}\u0001${sequence}`, { ...key, mode });
      }
    }
    for (const key of finalKeys.values()) {
      if (typeof key.rhs == "string" && !this.#actions.has(key.rhs)) {
        // The action's plugin is disabled or failed; the key would do nothing.
        plugin.warnings.push(
          `"${key.lhs}" (${key.mode}) maps to unknown action "${key.rhs}"`
        );
        continue;
      }
      if (key.rhs !== false) {
        this.#keymap.set(key.mode, key.lhs, key.rhs, {
          desc: key.desc ?? this.#actions.get(key.rhs)?.desc,
          owner: plugin.name,
        });
      }
    }

    for (const { groups } of fragments) {
      for (const group of (groups ?? []).map(normalizeGroup)) {
        this.#keymap.group(group.mode ?? "n", group.lhs, group.name, {
          owner: plugin.name,
        });
      }
    }

    // Like lazy.nvim's `config`, a later setup replaces an earlier one.
    const setup = fragments.findLast(
      fragment => fragment.setup !== undefined
    )?.setup;
    setup?.(plugin, opts, { actions: this.#actions, keymap: this.#keymap });
  }
}
