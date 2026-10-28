import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Store } from "../src/store.js";
import { parseSearch, slackExtension, SlackThread, SlackWatcher, type SlackApi, type SlackMe } from "../src/slack.js";
import { tempStore, until } from "./helpers.js";

const result = (r: {
  channel: string;
  from: string;
  ts: string;
  thread?: string;
  text: string;
  bot?: boolean;
}) => `Channel: ${r.channel}
From: ${r.from}${r.bot ? "  [BOT]" : " "}
Time: 2026-10-27 14:51:14 PDT
Message_ts: ${r.ts}
Permalink: [link](https://x.slack.com/archives/C/p1${r.thread ? `?thread_ts=${r.thread}&cid=C` : ""})
Text: 
${r.text}
Context after: 
- From: Someone (ID: U9) 
  Message_ts: 1.2
  not this

---
`;
const search = (...rows: Parameters<typeof result>[0][]) =>
  JSON.stringify({
    results: `# Search Results for: \n\n## Messages (${rows.length} results)\n${rows
      .map((r, i) => `### Result ${i + 1} of ${rows.length}\n${result(r)}`)
      .join("\n")}`,
  });

test("slack: parse search results", () => {
  const [dm, reply] = parseSearch(
    search(
      { channel: "DM (ID: D1)", from: "Ann Lee (ID: U1)", ts: "100.1", text: "can you look?" },
      { channel: "#eng (ID: C1)", from: "Bob <b@x.com> (ID: U2)", ts: "101.1", thread: "90.1", text: "<@UME> ping", bot: true },
    ),
  );
  assert.deepEqual(
    { ...dm, permalink: undefined },
    { channel: "D1", channelName: "DM", user: "U1", userName: "Ann Lee", bot: false, ts: "100.1", time: "2026-10-27 14:51:14 PDT", permalink: undefined, text: "can you look?" },
  );
  assert.equal(reply.userName, "Bob");
  assert.equal(reply.bot, true);
  assert.equal(reply.threadTs, "90.1");
  assert.equal(reply.text, "<@UME> ping");
});

test("slack: watcher gives each thread one agent, delivers once, drafts without sending", async () => {
  const t = await tempStore();
  const now = Date.now() / 1000;
  const ts = (s: number) => (now + s).toFixed(6);
  let dms: Parameters<typeof result>[0][] = [];
  let mentions: Parameters<typeof result>[0][] = [];
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const slack: SlackApi = {
    async call(tool, args) {
      calls.push({ tool, args });
      if (tool === "slack_read_user_profile") return JSON.stringify({ result: "User ID: UME\nReal Name: Me Myself\n" });
      if (tool === "slack_send_message_draft") return JSON.stringify({ result: "ok" });
      if (tool !== "slack_search_public_and_private") throw Error(`unexpected ${tool}`);
      const filters = String(args.filters);
      return filters.startsWith("to:") ? search(...dms) : filters.includes("on:") && calls.filter((c) => c.tool === tool).length % 3 === 2 ? search(...mentions) : search();
    },
  };
  const me: SlackMe = { id: "", name: "" };
  const extension = slackExtension(slack, me);
  const store = await Store.open({ ...t.options, extensions: [extension] });
  try {
    const watcher = new SlackWatcher(store, slack, extension, me, { pollMs: 60_000, ignore: new Set(["C_IGNORED"]) });
    await watcher.poll(); // learns who "me" is and the start time; nothing is new yet
    assert.equal(me.id, "UME");
    dms = [
      { channel: "DM (ID: D1)", from: "Ann (ID: U1)", ts: ts(5), text: "hi" },
      { channel: "DM (ID: D1)", from: "Me Myself (ID: UME)", ts: ts(6), text: "my own" },
      { channel: "DM (ID: D2)", from: "Bot (ID: B1)", ts: ts(7), text: "notice", bot: true },
      { channel: "DM (ID: D1)", from: "Ann (ID: U1)", ts: (now - 3600).toFixed(6), text: "old" },
    ];
    mentions = [
      { channel: "#eng (ID: C1)", from: "Bob (ID: U2)", ts: ts(8), text: "<@UME> look" },
      { channel: "#eng (ID: C1)", from: "Bob (ID: U2)", ts: ts(9), thread: ts(8), text: "<@UME> again" },
      { channel: "#noise (ID: C_IGNORED)", from: "Bob (ID: U2)", ts: ts(10), text: "<@UME> skip" },
    ];
    await watcher.poll();
    await watcher.poll(); // the same results again change nothing

    const session = store.resolveSession("Slack");
    const agents = (await store.agents(session)).filter((a) => a.id !== 1);
    assert.deepEqual(agents.map((a) => a.name).sort(), ["#eng · Bob", "DM · Ann"]);
    const h = store.harness(session);
    const inputs = async (id: number) =>
      (await store.activeEntries((await h.conversation(id as never, ctx))!))
        .filter((e) => (e as { kind?: string }).kind === "pi.user")
        .map((e) => JSON.stringify(e));
    const dm = agents.find((a) => a.name.startsWith("DM"))!;
    const eng = agents.find((a) => a.name.startsWith("#eng"))!;
    // The thread reply queues behind the first message as a follow-up in the same conversation.
    await until(async () => (await inputs(eng.id)).join("\n").includes("again"), 15000, "thread reply");
    assert.match((await inputs(eng.id)).join("\n"), /look/);
    assert.equal((await inputs(dm.id)).filter((e) => e.includes("New Slack")).length, 1);

    // draft_reply saves a Slack draft in the agent's own thread; nothing here can send.
    const c = (await h.conversation(eng.id as never, ctx))!;
    assert.deepEqual((await c.agent(ctx)).tools.map((tool) => tool.name).sort(), ["draft_reply", "slack_read"]);
    const sub = await store.send(c, { content: "draft: On it today.", requestId: "test:draft" });
    const done = await store.settled(h, sub.id as number, 20_000);
    assert.equal(done.status, "done");
    const drafts = calls.filter((x) => x.tool === "slack_send_message_draft");
    assert.deepEqual(drafts.map((d) => d.args), [{ channel_id: "C1", message: "On it today.", thread_ts: ts(8) }]);
    assert.equal((await h.snapshot(SlackThread, c.id, ctx))?.drafts[0]?.status, "saved");
    assert.ok(!calls.some((x) => /send_message$|schedule|reaction/.test(x.tool)));
  } finally {
    await store.close();
    await t.cleanup();
  }
});
