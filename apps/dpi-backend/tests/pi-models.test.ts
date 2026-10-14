import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { PromptInput, ToolExecutionApi } from "@earendil-works/pi-durable";
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
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const options = { ...t.options, provider: "pi" as const };
  const { Store } = await import("../src/store.js");
  let store = await Store.open(options);
  try {
    const info = store.deviceInfo();
    assert.equal(info.defaultModel, "m2");
    assert.deepEqual([info.models[0].provider, info.models[0].id], ["local", "m2"]);
    assert.ok(info.models.some((m) => m.provider === "local" && m.id === "m1"));
    await assert.rejects(
      () => store.create({ name: "Bad", cwd: t.work, model: { provider: "local", modelId: "nope" } }),
      /Unknown model/,
    );
    await store.create({ name: "One", cwd: t.work, model: { provider: "local", modelId: "m1" } });

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

    // A relative path resolves against the agent's folder, not the backend's home.
    const search = agent.tools.find((x) => x.name === "web_search")!;
    const api = { callId: "c1", agent: async () => agent } as unknown as ToolExecutionApi;
    const result = await search.execute({ path: "notes.pdf" }, api, ctx);
    assert.deepEqual(result.content, [{ type: "text", text: `web_search path=${join(t.work, "notes.pdf")}` }]);

    await store.setExtension(row, c, { name: "pi", enabled: false });
    assert.ok(!(await c.agent(ctx)).tools.some((x) => x.name === "web_search"));

    await store.close();
    store = await Store.open(options);
    assert.equal(store.resolveSession("one").model, "m1");
  } finally {
    await store.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await t.cleanup();
  }
});
