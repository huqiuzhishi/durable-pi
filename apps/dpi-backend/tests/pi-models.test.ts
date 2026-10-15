import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { HookApi, PromptInput, ToolExecutionApi, ToolHooks } from "@earendil-works/pi-durable";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { tempStore } from "./helpers.js";

const FAKE_EXTENSION = `export default function (pi) {
  const tool = (name) => ({
    name,
    label: name,
    description: "fake " + name,
    parameters: { type: "object", properties: { path: { type: "string" } } },
    execute: async (_id, params) => ({ content: [{ type: "text", text: name + " path=" + params.path }], details: {} }),
  });
  pi.registerTool(tool("web_search"));
  pi.registerTool(tool("questionnaire"));
}
`;

// Like the devspace security extension: a tool_call handler that resolves paths against ctx.cwd.
const POLICY_EXTENSION = `import { resolve } from "node:path";
export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "read" && resolve(ctx.cwd, event.input.path).endsWith("/project/secret.txt"))
      return { block: true, reason: "Reading protected path is not allowed: " + event.input.path };
    if (event.toolName === "bash" && event.input.command.includes("git config")) return { block: true, reason: "" };
    if (event.toolName === "bash") event.input.command = "set -e; " + event.input.command;
  });
}
`;

test("DPI_PROVIDER=pi: Pi's models, default model, skills, AGENTS.md and allowlisted extension tools", async () => {
  const t = await tempStore();
  const agentDir = join(t.root, "pi-agent");
  await mkdir(join(agentDir, "skills", "hello"), { recursive: true });
  await mkdir(join(agentDir, "extensions"));
  const models = [{ id: "m1" }, { id: "m2" }];
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({ providers: { local: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "x", models } } }),
  );
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "m2" }));
  await writeFile(join(agentDir, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: Say hello politely.\n---\nSay hello.\n");
  await writeFile(join(agentDir, "AGENTS.md"), "Always answer in haiku.\n");
  await writeFile(join(agentDir, "extensions", "fake.ts"), FAKE_EXTENSION);
  const policyFile = join(t.root, "policy.ts");
  await writeFile(policyFile, POLICY_EXTENSION);
  // extra-models.json: m3 joins provider local; m1 is already there and stays as models.json defines it.
  const extra = { local: [{ id: "m3", name: "M3", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, { id: "m1", name: "dup" }] };
  await writeFile(join(t.root, "extra-models.json"), JSON.stringify(extra));
  const previousHome = process.env.DPI_HOME;
  process.env.DPI_HOME = t.root;
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.TMUX = "/tmp/tmux-test,123,0";
  process.env.TMUX_PANE = "%999";
  const options = { ...t.options, provider: "pi" as const };
  const { Store } = await import("../src/store.js");
  process.env.DPI_PI_EXTENSIONS = join(t.root, "missing.ts");
  await assert.rejects(() => Store.open(options), /DPI_PI_EXTENSIONS: .*missing\.ts/);
  assert.equal(process.env.TMUX, undefined);
  assert.equal(process.env.TMUX_PANE, undefined);
  process.env.DPI_PI_EXTENSIONS = policyFile;
  let store = await Store.open(options);
  try {
    const info = store.deviceInfo();
    assert.equal(info.defaultModel, "m2");
    assert.deepEqual([info.models[0].provider, info.models[0].id], ["local", "m2"]);
    assert.ok(info.models.some((m) => m.provider === "local" && m.id === "m1"));
    assert.deepEqual(info.models.filter((m) => m.provider === "local").map((m) => m.id).sort(), ["m1", "m2", "m3"]);
    assert.equal(info.models.find((m) => m.id === "m1")?.name, "m1");
    await assert.rejects(
      () => store.create({ name: "Bad", cwd: t.work, model: { provider: "local", modelId: "nope" } }),
      /Unknown model/,
    );
    await store.create({ name: "One", cwd: join(t.work, "project"), model: { provider: "local", modelId: "m1" } });

    // The pi add-on is on by default and lists in the Extend tab.
    const { row, c } = await store.resolveAgent("one", "main");
    const ext = await store.extensionsOf(row, c);
    assert.equal(ext.extensions.find((e) => e.name === "pi")?.enabled, true);
    const agent = await c.agent(ctx);
    const names = agent.tools.map((x) => x.name);
    assert.ok(names.includes("web_search"));
    assert.ok(!names.includes("questionnaire"));

    const render = async (key: string) =>
      agent.sections.find((s) => s.key === key)!.render({ agent } as unknown as PromptInput, ctx);
    assert.match(String(await render("skills")), /hello[\s\S]*Say hello politely/);
    assert.match(String(await render("project_context")), /Always answer in haiku/);

    // `/skill:<name> [request]` inlines the skill like pi; device info lists the skills for the composer menu.
    assert.deepEqual(info.skills?.find((s) => s.name === "hello"), { name: "hello", description: "Say hello politely." });
    const { expandSkillCommand } = await import("../src/pi-models.js");
    const dir = join(agentDir, "skills", "hello");
    const hello = { name: "hello", description: "", filePath: join(dir, "SKILL.md"), baseDir: dir } as Skill;
    assert.equal(
      expandSkillCommand("/skill:hello to Bob", [hello]),
      `<skill name="hello" location="${hello.filePath}">\nReferences are relative to ${dir}.\n\nSay hello.\n</skill>\n\nto Bob`,
    );
    assert.equal(expandSkillCommand("/skill:nope hi", [hello]), "/skill:nope hi");

    // A relative path resolves against the agent's folder, not the backend's home.
    const search = agent.tools.find((x) => x.name === "web_search")!;
    const api = { callId: "c1", agent: async () => agent } as unknown as ToolExecutionApi;
    const result = await search.execute({ path: "notes.pdf" }, api, ctx);
    assert.deepEqual(result.content, [{ type: "text", text: `web_search path=${join(t.work, "project", "notes.pdf")}` }]);

    // DPI_PI_EXTENSIONS: its tool_call handlers guard every tool call, with the agent's cwd, and cannot be turned off.
    assert.ok(ext.builtIn.includes("pi-policy"));
    const policy = agent.extensions.find((e) => e.name === "pi-policy")!.hooks![0].handlers as ToolHooks;
    const before = (name: string, args: Record<string, string>) =>
      policy.beforeTool({ type: "toolCall", id: "t1", name, arguments: args }, { conversationId: c.id } as HookApi, ctx);
    assert.deepEqual(await before("read", { path: "secret.txt" }), { block: "Reading protected path is not allowed: secret.txt" });
    assert.equal(await before("read", { path: "other.txt" }), undefined);
    assert.match((await before("bash", { command: "git config -l" }))!.block!, /blocked by .*policy\.ts/);
    assert.deepEqual(await before("bash", { command: "ls" }), { arguments: { command: "set -e; ls" } });

    await store.setExtension(row, c, { name: "pi", enabled: false });
    assert.ok(!(await c.agent(ctx)).tools.some((x) => x.name === "web_search"));

    await store.close();
    store = await Store.open(options);
    assert.equal(store.resolveSession("one").model, "m1");
  } finally {
    await store.close();
    delete process.env.DPI_PI_EXTENSIONS;
    if (previousHome === undefined) delete process.env.DPI_HOME;
    else process.env.DPI_HOME = previousHome;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await t.cleanup();
  }
});
