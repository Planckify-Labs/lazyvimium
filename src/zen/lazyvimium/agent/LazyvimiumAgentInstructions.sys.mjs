// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// The user's standing instructions for their agent: short guidelines, each
// with a title and a switch, kept in the profile and added to every request
// while they are on. They are the user's own, so the agent follows them as
// it does the request, unlike text it reads on a page.

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const SAVE_DELAY_MS = 400;
// Anything longer is a document to attach, not a guideline.
export const MAX_INSTRUCTION_CHARS = 4000;
// The file an instruction comes with, one at most.
export const MAX_INSTRUCTION_FILE_BYTES = 25 * 1024 * 1024;

function validFile(file, dir) {
  // Only a copy this store made, at <dir>/<id>/<name>: the agent is told to
  // read whatever path is here, so a hand-edited file must not point it
  // elsewhere.
  if (
    !file ||
    typeof file.path != "string" ||
    typeof file.name != "string" ||
    PathUtils.parent(PathUtils.parent(file.path)) != dir
  ) {
    return null;
  }
  return {
    name: file.name,
    size: Number(file.size) || 0,
    path: file.path,
  };
}

/**
 * @typedef {object} LazyvimiumInstruction
 * @property {string} id Names it among the others.
 * @property {string} title What the list shows.
 * @property {string} text The guideline itself.
 * @property {boolean} enabled Whether requests carry it.
 * @property {LazyvimiumInstructionFile|null} file The one file it comes with.
 */

/**
 * @typedef {object} LazyvimiumInstructionFile
 * @property {string} name What the user called it.
 * @property {number} size In bytes.
 * @property {string} path The copy kept in the profile, which the agent reads.
 */

class LazyvimiumInstructionStore {
  /** @type {LazyvimiumInstruction[]} */
  #items = [];
  #listeners = new Set();
  #loaded = null;
  #timer = null;
  #lastId = 0;

  get path() {
    return PathUtils.join(
      PathUtils.profileDir,
      "lazyvimium",
      "agent",
      "instructions.json"
    );
  }

  /**
   * Read the file, once. Everything else needs it done first.
   *
   * @returns {Promise<void>}
   */
  load() {
    this.#loaded ??= (async () => {
      try {
        const data = await IOUtils.readJSON(this.path);
        const items = Array.isArray(data?.instructions)
          ? data.instructions
          : [];
        // Anything added while it was read stays after what was saved.
        this.#items = [
          ...items.flatMap(item =>
            item && typeof item == "object"
              ? [
                  {
                    id: String(item.id ?? this.#newId()),
                    title: String(item.title ?? ""),
                    text: String(item.text ?? "").slice(
                      0,
                      MAX_INSTRUCTION_CHARS
                    ),
                    enabled: item.enabled !== false,
                    file: validFile(item.file, this.filesDir),
                  },
                ]
              : []
          ),
          ...this.#items,
        ];
      } catch (e) {
        // Nothing saved yet, or a file that is not ours: start empty.
        if (!DOMException.isInstance(e) || e.name != "NotFoundError") {
          console.warn("Lazyvimium: could not read the instructions", e);
        }
      }
      this.#notify();
    })();
    return this.#loaded;
  }

  /** Where the files the instructions come with are kept, one folder each. */
  get filesDir() {
    return PathUtils.join(
      PathUtils.profileDir,
      "lazyvimium",
      "agent",
      "instruction-files"
    );
  }

  /** @returns {readonly LazyvimiumInstruction[]} */
  get items() {
    return this.#items;
  }

  /**
   * @returns {number} How many are on.
   */
  get activeCount() {
    return this.#items.filter(item => this.#counts(item)).length;
  }

  /**
   * @param {() => void} listener Called after every change.
   * @returns {() => void} Removes it.
   */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #newId() {
    return `${Date.now().toString(36)}${(++this.#lastId).toString(36)}`;
  }

  /**
   * @returns {LazyvimiumInstruction} A new, empty instruction, on.
   */
  add() {
    const item = {
      id: this.#newId(),
      title: "",
      text: "",
      enabled: true,
      file: null,
    };
    this.#items.push(item);
    this.#changed();
    return item;
  }

  /**
   * @param {string} id
   * @param {Partial<LazyvimiumInstruction>} fields
   */
  update(id, { title, text, enabled }) {
    const item = this.#items.find(i => i.id == id);
    if (!item) {
      return;
    }
    if (typeof title == "string") {
      item.title = title;
    }
    if (typeof text == "string") {
      item.text = text.slice(0, MAX_INSTRUCTION_CHARS);
    }
    if (typeof enabled == "boolean") {
      item.enabled = enabled;
    }
    this.#changed();
  }

  /**
   * @param {string} id
   */
  remove(id) {
    const index = this.#items.findIndex(i => i.id == id);
    if (index >= 0) {
      this.#items.splice(index, 1);
      this.#dropFiles(id);
      this.#changed();
    }
  }

  /**
   * Give an instruction its file, in place of the one it had: a copy is kept
   * in the profile, so it stays whatever happens to the original.
   *
   * @param {string} id
   * @param {{name: string, path?: string, bytes?: Uint8Array}} source A file
   *   on disk, or the bytes of one that is not.
   * @throws {Error} Saying why it cannot be the file.
   */
  async setFile(id, { name, path, bytes }) {
    if (!this.#items.some(item => item.id == id)) {
      return;
    }
    let size = bytes?.length;
    if (!bytes) {
      const info = await IOUtils.stat(path).catch(() => null);
      if (!info) {
        throw new Error("could not be read");
      }
      if (info.type == "directory") {
        throw new Error("is a folder");
      }
      size = info.size;
    }
    if (size > MAX_INSTRUCTION_FILE_BYTES) {
      throw new Error("is over 25 MB");
    }
    // Never a path: the name only picks the copy's.
    const safe =
      String(name)
        .replace(/[\\/\0]/g, "_")
        .slice(-120) || "file";
    const dir = PathUtils.join(this.filesDir, id);
    await this.#dropFiles(id);
    await IOUtils.makeDirectory(dir, { createAncestors: true });
    const copy = PathUtils.join(dir, safe);
    if (bytes) {
      await IOUtils.write(copy, bytes);
    } else {
      await IOUtils.copy(path, copy);
    }
    // It may have been deleted while the file was copied.
    const item = this.#items.find(i => i.id == id);
    if (!item) {
      await this.#dropFiles(id);
      return;
    }
    item.file = { name: safe, size, path: copy };
    this.#changed();
  }

  /**
   * @param {string} id
   */
  async removeFile(id) {
    const item = this.#items.find(i => i.id == id);
    if (item?.file) {
      item.file = null;
      this.#changed();
    }
    await this.#dropFiles(id);
  }

  async #dropFiles(id) {
    await IOUtils.remove(PathUtils.join(this.filesDir, id), {
      recursive: true,
      ignoreAbsent: true,
    }).catch(() => {});
  }

  #counts(item) {
    return item.enabled && (!!item.text.trim() || !!item.file);
  }

  /**
   * What the request carries: the instructions that are on, as a list, each
   * with the file it comes with.
   *
   * @returns {string} Empty when none is on.
   */
  promptBlock() {
    return this.#items
      .filter(item => this.#counts(item))
      .map((item, i) => {
        const title = item.title.trim() || `Instruction ${i + 1}`;
        const text = item.text.trim().replace(/\n+/g, "\n  ");
        const file = item.file ? `\n  File: ${item.file.path}` : "";
        return `- ${title}: ${text}${file}`;
      })
      .join("\n");
  }

  #changed() {
    this.#notify();
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.save().catch(e =>
        console.error("Lazyvimium: could not save the instructions", e)
      );
    }, SAVE_DELAY_MS);
  }

  #notify() {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (e) {
        console.error("Lazyvimium: instructions listener failed", e);
      }
    }
  }

  /**
   * Write what changed now, rather than after the delay.
   *
   * @returns {Promise<void>}
   */
  async save() {
    clearTimeout(this.#timer);
    this.#timer = null;
    await this.load();
    await IOUtils.makeDirectory(PathUtils.parent(this.path), {
      createAncestors: true,
      ignoreExisting: true,
    });
    await IOUtils.writeJSON(this.path, { instructions: this.#items });
  }
}

export const LazyvimiumAgentInstructions = new LazyvimiumInstructionStore();
