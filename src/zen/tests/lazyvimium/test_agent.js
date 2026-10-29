/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { LAZYVIMIUM_AGENTS, parseShellPath, parseVersion, runForOutput } =
  ChromeUtils.importESModule(
    "resource:///modules/lazyvimium/agent/LazyvimiumAgentDetect.sys.mjs"
  );
const {
  LAZYVIMIUM_DRIVERS,
  LazyvimiumAgentRun,
  STDIO_PROXY,
  TOKEN_ENV,
  URL_ENV,
} = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/agent/LazyvimiumAgentHarness.sys.mjs"
);
const { LazyvimiumAgentServer, handleMcpMessage } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/agent/LazyvimiumAgentServer.sys.mjs"
);
const { formatObservation } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/agent/LazyvimiumAgentTools.sys.mjs"
);
const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);
const { LazyvimiumAgentLog, summarize } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/agent/LazyvimiumAgentLog.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

do_get_profile();
registerCleanupFunction(() => LazyvimiumAgentServer.stop());

const TURN = {
  prompt: "Open the docs",
  resume: null,
  first: true,
  mcp: { url: "http://127.0.0.1:1234/mcp", token: "secret" },
  dir: "/tmp/agent",
  runId: "r1",
};

function parseAll(id, lines) {
  return lines.flatMap(line => LAZYVIMIUM_DRIVERS[id].parse(line));
}

// A session answering like LazyvimiumAgentToolbox, with fixed tools.
function fakeSession(calls = []) {
  return {
    listTools: () => [
      { name: "page_observe", inputSchema: { type: "object" } },
    ],
    async callTool(name, args) {
      calls.push({ name, args });
      if (name == "fail") {
        throw new Error("no page");
      }
      return { text: `observed ${JSON.stringify(args)}` };
    },
  };
}

function post(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

add_task(function test_known_agents() {
  Assert.deepEqual(
    LAZYVIMIUM_AGENTS.map(agent => agent.id),
    ["claude", "codex", "cursor", "antigravity", "opencode"]
  );
  for (const agent of LAZYVIMIUM_AGENTS) {
    ok(!!LAZYVIMIUM_DRIVERS[agent.id], `${agent.id} has a driver`);
  }
});

add_task(function test_shell_snapshot_parsing() {
  const output =
    "motd noise\n__LAZYVIMIUM_SHELL_ENV_BEGIN__\nHOME=/home/u\nPATH=/home/u/.nvm/bin:/usr/bin\n__LAZYVIMIUM_SHELL_ENV_END__\n";
  Assert.equal(parseShellPath(output), "/home/u/.nvm/bin:/usr/bin");
  Assert.equal(parseShellPath("PATH=/usr/bin"), null, "needs the markers");
  Assert.equal(parseVersion("2.1.312 (Claude Code)"), "2.1.312");
  Assert.equal(parseVersion("codex-cli 0.159.1"), "0.159.1");
  Assert.equal(parseVersion("no version"), null);
});

add_task(async function test_run_for_output_times_out() {
  const { stdout, exitCode } = await runForOutput("/bin/sh", ["-c", "echo hi"]);
  Assert.equal(stdout.trim(), "hi");
  Assert.equal(exitCode, 0);
  const slow = await runForOutput("/bin/sh", ["-c", "sleep 30"], { ms: 200 });
  Assert.equal(slow.exitCode, null, "a hung command is killed");
});

add_task(function test_claude_driver() {
  const { args, files } = LAZYVIMIUM_DRIVERS.claude.launch({
    ...TURN,
    resume: "s1",
  });
  Assert.equal(args[args.indexOf("--mcp-config") + 1], files[0].path);
  Assert.equal(args[args.indexOf("--allowedTools") + 1], "mcp__lazyvimium");
  Assert.equal(args[args.indexOf("--resume") + 1], "s1");
  ok(
    !args.join(" ").includes("secret"),
    "the token stays off the command line"
  );
  Assert.equal(
    files[0].data.mcpServers.lazyvimium.headers.Authorization,
    "Bearer secret"
  );
  ok(files[0].temporary, "its config is removed after the turn");

  const events = parseAll("claude", [
    { type: "system", subtype: "init", session_id: "s2" },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "mcp__lazyvimium__page_observe",
            input: {},
          },
          // Recorded from Claude Code 2.1.312, loading lazyvimium's tools.
          { type: "tool_use", name: "ToolSearch", input: { query: "x" } },
          { type: "tool_use", name: "WebSearch", input: { query: "x" } },
          { type: "text", text: "Opened it" },
        ],
      },
    },
    { type: "result", is_error: false, session_id: "s2" },
  ]);
  Assert.deepEqual(events, [
    { type: "session", id: "s2" },
    { type: "tool", name: "WebSearch", input: { query: "x" } },
    { type: "text", text: "Opened it", final: true },
    { type: "session", id: "s2" },
    { type: "done", error: null },
  ]);
  Assert.deepEqual(
    parseAll("claude", [
      { type: "result", is_error: true, result: "Out of credit" },
    ]),
    [{ type: "done", error: "Out of credit" }]
  );
});

add_task(function test_claude_streams_its_answer() {
  ok(
    LAZYVIMIUM_DRIVERS.claude
      .launch(TURN)
      .args.includes("--include-partial-messages")
  );
  const delta = text => ({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  });
  Assert.deepEqual(
    parseAll("claude", [
      { type: "stream_event", event: { type: "message_start" } },
      delta("**Pri"),
      delta("ce**"),
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: "{" },
        },
      },
    ]),
    [
      { type: "text", text: "**Pri", delta: true },
      { type: "text", text: "ce**", delta: true },
    ],
    "the answer's pieces, without the tool input's"
  );
});

add_task(function test_drivers_run_the_model_picked() {
  for (const [id, flag] of [
    ["claude", "--model"],
    ["cursor", "--model"],
    ["antigravity", "--model"],
    ["opencode", "--model"],
  ]) {
    const { args } = LAZYVIMIUM_DRIVERS[id].launch({ ...TURN, model: "m1" });
    Assert.equal(args[args.indexOf(flag) + 1], "m1", id);
    ok(
      !LAZYVIMIUM_DRIVERS[id].launch(TURN).args.includes(flag),
      `${id} keeps its own model when none is picked`
    );
  }
  const codex = LAZYVIMIUM_DRIVERS.codex.launch({
    ...TURN,
    model: "gpt-x",
    resume: "t1",
  }).args;
  ok(
    codex.indexOf('model="gpt-x"') < codex.indexOf("exec"),
    "codex takes it as config, which exec resume takes too"
  );
});

add_task(async function test_drivers_list_models() {
  const run = stdout => async () => ({ stdout, exitCode: 0 });
  // Recorded from agy, OpenCode and Codex on 2026-10-30.
  Assert.deepEqual(
    await LAZYVIMIUM_DRIVERS.antigravity.models(
      run(
        "Fetching available models...\ngemini-4-argon-high\tGemini 4 Argon (High)\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\n"
      )
    ),
    [
      { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
      { id: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)" },
    ]
  );
  Assert.deepEqual(
    (
      await LAZYVIMIUM_DRIVERS.opencode.models(
        run("opencode/big-pickle\nanthropic/claude-sonnet-5-5\n")
      )
    ).map(model => model.id),
    ["opencode/big-pickle", "anthropic/claude-sonnet-5-5"]
  );
  Assert.deepEqual(
    await LAZYVIMIUM_DRIVERS.codex.models(
      run(
        JSON.stringify({
          models: [
            { slug: "hidden", visibility: "hide", priority: 0 },
            {
              slug: "gpt-b",
              display_name: "GPT B",
              visibility: "list",
              priority: 2,
            },
            {
              slug: "gpt-a",
              display_name: "GPT A",
              description: "Fast",
              visibility: "list",
              priority: 1,
            },
          ],
        })
      )
    ),
    [
      { id: "gpt-a", name: "GPT A", detail: "Fast" },
      { id: "gpt-b", name: "GPT B", detail: "" },
    ]
  );
  Assert.deepEqual(
    await LAZYVIMIUM_DRIVERS.codex.models(run("not json")),
    [],
    "an output it cannot read lists nothing"
  );
  Assert.deepEqual(
    (await LAZYVIMIUM_DRIVERS.claude.models()).map(model => model.id),
    ["opus", "sonnet", "haiku"]
  );
});

add_task(function test_codex_driver() {
  const { args } = LAZYVIMIUM_DRIVERS.codex.launch({
    ...TURN,
    resume: "t1",
    first: false,
  });
  ok(args.includes('mcp_servers.lazyvimium.url="http://127.0.0.1:1234/mcp"'));
  ok(
    args.includes(`mcp_servers.lazyvimium.bearer_token_env_var="${TOKEN_ENV}"`)
  );
  Assert.deepEqual(args.slice(args.indexOf("exec"), args.indexOf("exec") + 2), [
    "exec",
    "resume",
  ]);
  ok(!args.join(" ").includes("secret"));
  Assert.equal(args.at(-2), "t1");
  Assert.equal(
    args.at(-1),
    "Open the docs",
    "no instructions after the first turn"
  );

  const events = parseAll("codex", [
    { type: "thread.started", thread_id: "t2" },
    {
      type: "item.completed",
      item: { type: "mcp_tool_call", server: "lazyvimium", tool: "page_act" },
    },
    { type: "item.completed", item: { type: "agent_message", text: "Done" } },
    { type: "turn.failed", error: { message: "rate limited" } },
  ]);
  Assert.deepEqual(events, [
    { type: "session", id: "t2" },
    { type: "text", text: "Done" },
    { type: "done", error: "rate limited" },
  ]);
});

add_task(function test_antigravity_driver() {
  const { args } = LAZYVIMIUM_DRIVERS.antigravity.launch(TURN);
  ok(args.includes("--dangerously-skip-permissions"));
  Assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  ok(args[1].includes("lazyvimium") && args[1].endsWith("Open the docs"));
  ok(!args.includes("--conversation"));
  const resumed = LAZYVIMIUM_DRIVERS.antigravity.launch({
    ...TURN,
    resume: "c1",
  });
  Assert.equal(resumed.args[resumed.args.indexOf("--conversation") + 1], "c1");

  // Recorded from agy 1.4.9.
  const events = parseAll("antigravity", [
    { event: "init", conversation_id: "c2", init: { tools: [] } },
    {
      event: "step_update",
      step_update: { step_type: "user_input", state: "DONE" },
    },
    {
      event: "step_update",
      step_update: {
        step_type: "agent_response",
        state: "ACTIVE",
        text_delta: "o",
      },
    },
    {
      event: "step_update",
      step_update: {
        step_type: "agent_response",
        state: "DONE",
        text_delta: "k",
      },
    },
    { event: "result", result: { conversation_id: "c2", status: "SUCCESS" } },
  ]);
  Assert.deepEqual(events, [
    { type: "session", id: "c2" },
    { type: "text", text: "o", delta: true },
    { type: "text", text: "k", delta: true },
    { type: "done", error: null },
  ]);
});

add_task(async function test_antigravity_connects_once() {
  const calls = [];
  const agy = async args => {
    calls.push(args);
    return args[1] == "list"
      ? { stdout: "NAME  TYPE  STATUS\nplanck  stdio  enabled\n", exitCode: 0 }
      : { stdout: "", exitCode: 0 };
  };
  ok(await LAZYVIMIUM_DRIVERS.antigravity.ensureConnected(agy));
  Assert.deepEqual(calls[1].slice(0, 6), [
    "mcp",
    "add",
    "lazyvimium",
    "--",
    "/bin/sh",
    "-c",
  ]);
  Assert.equal(calls[1][6], STDIO_PROXY);

  calls.length = 0;
  const connected = async args => {
    calls.push(args);
    return { stdout: "NAME TYPE\nlazyvimium  stdio  enabled\n", exitCode: 0 };
  };
  ok(await LAZYVIMIUM_DRIVERS.antigravity.ensureConnected(connected));
  Assert.equal(calls.length, 1, "nothing is added twice");
});

add_task(function test_opencode_and_cursor_drivers() {
  const { args, env, files } = LAZYVIMIUM_DRIVERS.opencode.launch(TURN);
  Assert.equal(env.OPENCODE_CONFIG, files[0].path);
  Assert.equal(
    files[0].data.mcp.lazyvimium.headers.Authorization,
    `Bearer {env:${TOKEN_ENV}}`
  );
  Assert.deepEqual(args.slice(0, 3), ["run", "--format", "json"]);
  Assert.deepEqual(
    parseAll("opencode", [
      { type: "text", sessionID: "o1", part: { text: "Hi" } },
      { type: "error", error: { data: { message: "No model" } } },
    ]),
    [
      { type: "session", id: "o1" },
      { type: "text", text: "Hi" },
      { type: "done", error: "No model" },
    ]
  );

  const cursor = LAZYVIMIUM_DRIVERS.cursor.launch(TURN);
  ok(cursor.files[0].path.endsWith(".cursor/mcp.json"));
  Assert.equal(
    cursor.files[0].data.mcpServers.lazyvimium.headers.Authorization,
    `Bearer \${env:${TOKEN_ENV}}`
  );
  ok(cursor.args.includes("--approve-mcps"));
});

add_task(async function test_mcp_messages() {
  const session = fakeSession();
  const init = await handleMcpMessage(session, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  Assert.equal(init.result.protocolVersion, "2025-06-18");
  ok(init.result.capabilities.tools);
  const unknownVersion = await handleMcpMessage(session, {
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "1999-01-01" },
  });
  Assert.equal(unknownVersion.result.protocolVersion, "2025-11-25");

  Assert.equal(
    await handleMcpMessage(session, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
    null
  );
  const list = await handleMcpMessage(session, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/list",
  });
  Assert.equal(list.result.tools[0].name, "page_observe");
  const call = await handleMcpMessage(session, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "page_observe", arguments: { a: 1 } },
  });
  Assert.deepEqual(call.result, {
    content: [{ type: "text", text: 'observed {"a":1}' }],
    isError: false,
  });
  const failed = await handleMcpMessage(session, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "fail" },
  });
  ok(
    failed.result.isError,
    "a failed tool is a tool error, not a protocol one"
  );
  const unknown = await handleMcpMessage(session, {
    jsonrpc: "2.0",
    id: 6,
    method: "resources/list",
  });
  Assert.equal(unknown.error.code, -32601);
});

add_task(async function test_server_needs_a_live_token() {
  const calls = [];
  const token = LazyvimiumAgentServer.open(fakeSession(calls));
  const url = LazyvimiumAgentServer.url;
  ok(url.startsWith("http://127.0.0.1:"));
  const call = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "page_observe", arguments: { note: "héllo ✓" } },
  };

  let response = await post(url, call, { Authorization: `Bearer ${token}` });
  Assert.equal(response.status, 200);
  const body = await response.json();
  Assert.equal(body.result.content[0].text, 'observed {"note":"héllo ✓"}');

  response = await post(url, call);
  Assert.equal(response.status, 401, "no token, no tools");
  response = await post(url, call, { Authorization: "Bearer guessed" });
  Assert.equal(response.status, 401);
  // fetch drops Origin, a forbidden header; a page's request carries it.
  const fromPage = await runForOutput("/usr/bin/env", [
    "curl",
    "-s",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    "-H",
    `Authorization: Bearer ${token}`,
    "-H",
    "Origin: https://evil.example",
    "--data-binary",
    JSON.stringify(call),
    url,
  ]);
  Assert.equal(fromPage.stdout, "403", "web pages are refused");
  response = await post(
    url,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { Authorization: `Bearer ${token}` }
  );
  Assert.equal(response.status, 202);
  response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  Assert.equal(response.status, 405, "no event stream");

  LazyvimiumAgentServer.close(token);
  response = await post(url, call, { Authorization: `Bearer ${token}` });
  Assert.equal(response.status, 401, "a closed run's token is dead");
  Assert.equal(calls.length, 1);
});

add_task(async function test_stdio_proxy() {
  const token = LazyvimiumAgentServer.open(fakeSession());
  const proc = await Subprocess.call({
    command: "/bin/sh",
    arguments: ["-c", STDIO_PROXY],
    environment: { [URL_ENV]: LazyvimiumAgentServer.url, [TOKEN_ENV]: token },
    environmentAppend: true,
    stderr: "stdout",
  });
  await proc.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" })}\n`
  );
  await proc.stdin.close();
  let output = "";
  let chunk;
  while ((chunk = await proc.stdout.readString())) {
    output += chunk;
  }
  await proc.wait();
  const lines = output.trim().split("\n");
  Assert.equal(lines.length, 1, "notifications get no line back");
  Assert.equal(JSON.parse(lines[0]).result.tools[0].name, "page_observe");
  LazyvimiumAgentServer.close(token);

  const idle = await runForOutput("/bin/sh", ["-c", STDIO_PROXY], { ms: 2000 });
  Assert.equal(idle.exitCode, 0, "outside a lazyvimium run it exits at once");
});

add_task(async function test_run_with_a_fake_agent() {
  const dir = PathUtils.join(PathUtils.profileDir, "fake-agent");
  await IOUtils.makeDirectory(dir);
  const script = PathUtils.join(dir, "claude");
  // An agent in Claude Code's stream-json shapes, which reads its MCP config
  // file and calls a tool with curl.
  await IOUtils.writeUTF8(
    script,
    `#!/bin/sh
config=""
while [ $# -gt 0 ]; do
  [ "$1" = "--mcp-config" ] && config="$2"
  shift
done
token=$(sed -n 's/.*"Authorization": "Bearer \\([0-9a-f]*\\)".*/\\1/p' "$config")
echo '{"type":"system","subtype":"init","session_id":"fake-1"}'
answer=$(printf '%s' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"page_observe","arguments":{}}}' |
  curl -sS -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data-binary @- "$${URL_ENV}")
case "$answer" in *observed*) said="saw the page" ;; *) said="saw nothing" ;; esac
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"'"$said"'"}]}}'
echo '{"type":"result","is_error":false,"result":"ok","session_id":"fake-1"}'
`
  );
  await IOUtils.setPermissions(script, 0o755);

  const calls = [];
  const token = LazyvimiumAgentServer.open(fakeSession(calls));
  const events = [];
  const log = new LazyvimiumAgentLog({
    dir: PathUtils.join(dir, "logs"),
    agent: "claude",
  });
  const run = new LazyvimiumAgentRun({
    driver: LAZYVIMIUM_DRIVERS.claude,
    executable: script,
    path: "/usr/bin:/bin",
    turn: {
      ...TURN,
      dir,
      mcp: { url: LazyvimiumAgentServer.url, token },
    },
    onEvent: event => events.push(event),
    log,
  });
  await run.start();
  Assert.equal(await run.done, null);
  LazyvimiumAgentServer.close(token);

  // The process exits just after its result line.
  let entries = [];
  await TestUtils.waitForCondition(async () => {
    await log.flush();
    const text = await IOUtils.readUTF8(log.path);
    entries = text
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    return entries.some(entry => entry.kind == "exit");
  }, "the log records the exit");
  const kinds = entries.map(entry => entry.kind);
  Assert.equal(kinds[0], "spawn", "it starts with the command line");
  Assert.equal(entries[0].executable, script);
  Assert.equal(
    kinds.filter(kind => kind == "stdout").length,
    3,
    "every line the agent printed"
  );
  ok(kinds.includes("event"), "and what the driver made of them");
  Assert.equal(entries.find(entry => entry.kind == "exit").exitCode, 0);
  ok(
    !(await IOUtils.readUTF8(log.path)).includes(token),
    "the token never reaches the log"
  );
  Assert.equal(
    (await IOUtils.stat(log.path)).permissions & 0o077,
    0,
    "only the user can read it"
  );

  Assert.deepEqual(events, [
    { type: "session", id: "fake-1" },
    { type: "text", text: "saw the page", final: true },
    { type: "session", id: "fake-1" },
    { type: "done", error: null },
  ]);
  Assert.equal(calls.length, 1, "the agent reached the tools");
  const left = (await IOUtils.getChildren(dir)).filter(path =>
    path.includes("claude-mcp-")
  );
  Assert.deepEqual(left, [], "the config with the token is removed");
});

add_task(async function test_run_reports_a_failing_agent() {
  const events = [];
  const run = new LazyvimiumAgentRun({
    driver: LAZYVIMIUM_DRIVERS.codex,
    executable: "/bin/sh",
    path: "/usr/bin:/bin",
    turn: { ...TURN, dir: PathUtils.join(PathUtils.profileDir, "fake-agent") },
    onEvent: event => events.push(event),
  });
  // /bin/sh runs codex's arguments: "-c" then a config string as a script.
  await run.start();
  const error = await run.done;
  ok(error, "a non-zero exit is an error");
  Assert.equal(events.at(-1).type, "done");
});

add_task(function test_observation_text() {
  const text = formatObservation({
    url: "https://example.com/",
    title: "Example",
    loading: false,
    scroll: { y: 0, height: 2000, viewport: 800 },
    elements: [
      { id: "e1", role: "link", label: "Docs" },
      { id: "e4", role: "textbox", label: "Search", value: "", editable: true },
      {
        id: "e9",
        role: "combobox",
        label: "Lang",
        value: "English",
        options: ["English", "Deutsch"],
      },
      { id: "e12", role: "checkbox", label: "Remember", checked: "false" },
    ],
    omitted: 3,
    text: "Welcome",
    selection: "picked words",
  });
  Assert.equal(
    text,
    [
      "Title: Example",
      "URL: https://example.com/",
      "Scroll: 0 of 1200px",
      'Selected text: "picked words"',
      "",
      "Elements in view:",
      '[e1] link "Docs"',
      '[e4] textbox "Search" value="" (editable)',
      '[e9] combobox "Lang" value="English" options: "English", "Deutsch"',
      '[e12] checkbox "Remember" checked=false',
      "(3 more not listed; scroll or act to see them)",
      "",
      "Visible text:",
      "Welcome",
    ].join("\n")
  );
  ok(
    formatObservation({
      url: "https://example.com/",
      title: "",
      scroll: { y: 10.4, height: 4050.4666748046875, viewport: 800 },
      elements: [],
      text: "",
    }).includes("Scroll: 10 of 3250px"),
    "scroll positions are whole pixels"
  );
  ok(
    formatObservation({
      url: "https://music.youtube.com/",
      title: "",
      scroll: { y: 0, height: 800, viewport: 800 },
      elements: [
        {
          id: "e70",
          role: "button",
          label: "Play",
          covered: 'ytmusic-player-page "Up next"',
        },
      ],
      text: "",
    }).includes(
      '[e70] button "Play" (covered by ytmusic-player-page "Up next")'
    ),
    "covered controls say so"
  );
});

add_task(async function test_log_redacts_and_rotates() {
  const dir = PathUtils.join(PathUtils.profileDir, "logs-test");
  const log = new LazyvimiumAgentLog({ dir, agent: "codex" });
  log.hide("s3cret-token");
  log.write("spawn", {
    executable: "/bin/codex",
    args: ["exec", "Bearer s3cret-token"],
  });
  log.write("tool", {
    name: "page_act",
    args: { action: "click", element: "e4" },
    ms: 140,
    isError: true,
    title: "click e4",
    text: "e4 is covered by div",
  });
  await log.flush();
  const text = await IOUtils.readUTF8(log.path);
  ok(text.includes("Bearer <token>"), "a hidden value is replaced");
  ok(!text.includes("s3cret-token"));
  Assert.equal(text.trim().split("\n").length, 2);
  Assert.equal(
    summarize(JSON.parse(text.trim().split("\n")[1])),
    'page_act {"action":"click","element":"e4"} → ERROR 140ms click e4'
  );

  for (let i = 0; i < 55; i++) {
    await IOUtils.writeUTF8(
      PathUtils.join(
        dir,
        `20200101-0000${String(i).padStart(2, "0")}-old.jsonl`
      ),
      ""
    );
  }
  new LazyvimiumAgentLog({ dir, agent: "codex" }).write("turn", {});
  await TestUtils.waitForCondition(
    async () => (await IOUtils.getChildren(dir)).length <= 50,
    "old logs are pruned"
  );
  ok(
    (await IOUtils.getChildren(dir)).some(path => path == log.path),
    "the newest ones stay"
  );

  Services.prefs.setBoolPref("lazyvimium.agent.log.enabled", false);
  const off = new LazyvimiumAgentLog({ dir, agent: "codex" });
  off.write("turn", {});
  Assert.equal(off.path, null, "logging can be turned off");
  Services.prefs.clearUserPref("lazyvimium.agent.log.enabled");
});
