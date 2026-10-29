// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// The browser's MCP server: the streamable HTTP transport on a loopback
// port, answering each JSON-RPC POST with a JSON body (no event streams).
// Every agent run gets a token of its own, which names the tab it works on;
// a request without a live token gets nothing. Web pages cannot reach it:
// browsers send an Origin header with every cross-origin POST, which is
// refused, and httpd answers 400 to any Host but its own, which stops DNS
// rebinding.

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  HttpServer: "chrome://remote/content/server/httpd.sys.mjs",
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
});

export const MCP_PATH = "/mcp";

// Newest first; an unknown version requested by a client gets the newest.
const PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

const MAX_BODY = 1024 * 1024;

/**
 * @typedef {object} LazyvimiumMcpSession What one token may do.
 * @property {() => object[]} listTools MCP tool descriptions.
 * @property {(name: string, args: object) => Promise<{text: string, isError?: boolean}>} callTool
 *   Runs a tool; a thrown error becomes a tool error the agent reads.
 */

export class LazyvimiumMcpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function toBinaryString(text) {
  const bytes = new TextEncoder().encode(text);
  let result = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    result += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return result;
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Answer one JSON-RPC message for a session.
 *
 * @param {LazyvimiumMcpSession} session
 * @param {object} message
 * @returns {Promise<object|null>} The response, or null for a notification.
 */
export async function handleMcpMessage(session, message) {
  const { id, method, params = {} } = message ?? {};
  const isRequest = id !== undefined && id !== null;
  const reply = result => (isRequest ? { jsonrpc: "2.0", id, result } : null);
  const fail = (code, text) =>
    isRequest ? { jsonrpc: "2.0", id, error: { code, message: text } } : null;
  if (message?.jsonrpc != "2.0" || typeof method != "string") {
    return fail(-32600, "Invalid request");
  }
  switch (method) {
    case "initialize": {
      const version = PROTOCOL_VERSIONS.includes(params.protocolVersion)
        ? params.protocolVersion
        : PROTOCOL_VERSIONS[0];
      return reply({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        // Clients refuse a server without a version string.
        serverInfo: {
          name: "lazyvimium",
          version: String(Services.appinfo.version || "0"),
        },
        instructions:
          "Tools for the browser tab the user asked from. Observe the page before acting on it.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: session.listTools() });
    case "tools/call": {
      if (typeof params.name != "string") {
        return fail(-32602, "tools/call needs a name");
      }
      try {
        const { text, isError = false } = await session.callTool(
          params.name,
          params.arguments ?? {}
        );
        return reply({ content: [{ type: "text", text }], isError });
      } catch (e) {
        if (e instanceof LazyvimiumMcpError) {
          return fail(e.code, e.message);
        }
        return reply({
          content: [{ type: "text", text: String(e?.message ?? e) }],
          isError: true,
        });
      }
    }
  }
  if (method.startsWith("notifications/")) {
    return null;
  }
  return fail(-32601, `Unknown method ${method}`);
}

class LazyvimiumAgentServerImpl {
  #server = null;
  /** @type {Map<string, LazyvimiumMcpSession>} */
  #sessions = new Map();

  /**
   * The server's address, starting it if needed.
   *
   * @returns {string}
   */
  get url() {
    this.#start();
    return `http://127.0.0.1:${this.#server.identity.primaryPort}${MCP_PATH}`;
  }

  /**
   * Let an agent in for as long as `session` lives.
   *
   * @param {LazyvimiumMcpSession} session
   * @returns {string} The token the agent must send.
   */
  open(session) {
    this.#start();
    const token = newToken();
    this.#sessions.set(token, session);
    return token;
  }

  /**
   * @param {string} token
   */
  close(token) {
    this.#sessions.delete(token);
  }

  stop() {
    this.#sessions.clear();
    const server = this.#server;
    this.#server = null;
    return server ? new Promise(resolve => server.stop(resolve)) : null;
  }

  #start() {
    if (this.#server) {
      return;
    }
    const server = new lazy.HttpServer();
    server.registerPathHandler(MCP_PATH, (request, response) =>
      this.#handle(request, response)
    );
    // "localhost" binds the loopback interface only.
    server.start(-1);
    this.#server = server;
  }

  #handle(request, response) {
    const send = (code, status, body = null) => {
      response.setStatusLine(request.httpVersion, code, status);
      if (body !== null) {
        response.setHeader("Content-Type", "application/json", false);
        response.write(toBinaryString(JSON.stringify(body)));
      }
    };
    if (request.hasHeader("Origin")) {
      send(403, "Forbidden");
      return;
    }
    const auth = request.hasHeader("Authorization")
      ? request.getHeader("Authorization")
      : "";
    const session = this.#sessions.get(auth.replace(/^Bearer\s+/i, ""));
    if (!session) {
      send(401, "Unauthorized");
      return;
    }
    if (request.method != "POST") {
      // No server-sent event stream; clients fall back to POST only.
      response.setHeader("Allow", "POST", false);
      send(405, "Method Not Allowed");
      return;
    }
    let message;
    try {
      const stream = request.bodyInputStream;
      const length = stream.available();
      if (length > MAX_BODY) {
        throw new Error("too large");
      }
      message = JSON.parse(
        lazy.NetUtil.readInputStreamToString(stream, length, {
          charset: "UTF-8",
        })
      );
    } catch {
      send(400, "Bad Request", {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }
    response.processAsync();
    const messages = Array.isArray(message) ? message : [message];
    Promise.all(messages.map(m => handleMcpMessage(session, m)))
      .then(results => {
        // Tool calls are logged by the toolbox with what they returned.
        messages.forEach((m, i) => {
          if (m?.method != "tools/call") {
            session.log?.write("mcp", {
              method: m?.method,
              error: results[i]?.error?.message,
              client: m?.params?.clientInfo,
            });
          }
        });
        const replies = results.filter(Boolean);
        if (!replies.length) {
          send(202, "Accepted");
        } else {
          send(200, "OK", Array.isArray(message) ? replies : replies[0]);
        }
      })
      .catch(e => {
        console.error("Lazyvimium: MCP request failed", e);
        send(500, "Internal Server Error");
      })
      .finally(() => response.finish());
  }
}

export const LazyvimiumAgentServer = new LazyvimiumAgentServerImpl();
