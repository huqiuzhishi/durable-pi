import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { tempStore } from "./helpers.js";

test("DPI_PROVIDER=pi: Pi's models.json and default model, kept per session across restarts", async () => {
  const t = await tempStore();
  const agentDir = join(t.root, "pi-agent");
  await mkdir(agentDir);
  const models = [{ id: "m1" }, { id: "m2" }];
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({ providers: { local: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "x", models } } }),
  );
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "m2" }));
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
