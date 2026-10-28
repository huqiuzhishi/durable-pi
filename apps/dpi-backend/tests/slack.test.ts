import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Store } from "../src/store.js";
import {
  isHighUrgencyAlert,
  oncallExtension,
  parseChannel,
  parseSearch,
  slackExtension,
  SlackThread,
  SlackWatcher,
  type SlackApi,
  type SlackMe,
} from "../src/slack.js";
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

const pd = (ts: string, urgency: string, alert: string) =>
  `=== Message from PagerDuty <botuser-T1-A1@slack-bots.com> (U2U6DJY15) at 2026-10-27 17:16:55 PDT === \nMessage TS: ${ts}\n:large_green_circle: *<https://roblox.pagerduty.com/incidents/Q1|Environment: production | Alert: ${alert} | Service: >*\n:tornado: *Urgency:* ${urgency}\nThread: 8 replies (latest: 2026-10-27 17:25:22 PDT)\n\n`;
const human = (ts: string, name: string, id: string, text: string) =>
  `=== Message from ${name} <x@roblox.com> (${id}) at 2026-10-27 13:08:23 PDT === \nMessage TS: ${ts}\n${text}\nReactions: +1 (1)\n\n`;
const channelRead = (...blocks: string[]) =>
  JSON.stringify({ messages: `Channel: #ts-oncall (C_ON)\n\n${blocks.join("")}` });

test("slack: parse a channel read and spot high-urgency PagerDuty alerts", () => {
  const [high, low, person, deploy] = parseChannel(
    channelRead(
      pd("10.1", "High", "Backlog_High"),
      pd("11.1", "Low", "Latency_High"),
      human("12.1", "Karun Prasad", "U07", "Deploying video-automod today"),
      "=== Message from Modern Deployment System (B054) at 2026-10-27 13:00:00 PDT === \nMessage TS: 13.1\nDeployed\n\n",
    ),
    "C_ON",
  );
  assert.equal(high.channelName, "#ts-oncall");
  assert.deepEqual([high, low, person, deploy].map(isHighUrgencyAlert), [true, false, false, false]);
  assert.deepEqual([high.bot, person.bot, deploy.bot], [true, false, true]);
  assert.equal(person.userName, "Karun Prasad");
  assert.equal(person.text, "Deploying video-automod today");
});

test("slack: on call, the agent drafts for humans and high-urgency alerts in the on-call channel only", async () => {
  const t = await tempStore();
  const now = Date.now() / 1000;
  const ts = (s: number) => (now + s).toFixed(6);
  let channel: string[] = [];
  const slack: SlackApi = {
    async call(tool) {
      if (tool === "slack_read_user_profile") return JSON.stringify({ result: "User ID: UME\nReal Name: Me Myself\n" });
      if (tool === "slack_read_channel") return channelRead(...channel);
      if (tool === "slack_search_public_and_private") return JSON.stringify({ results: "## Messages (0 results)" });
      throw Error(`unexpected ${tool}`);
    },
  };
  const gatewayCalls: string[] = [];
  const gateway = () => ({
    call: async (tool: string) => (gatewayCalls.push(tool), "rows"),
    listTools: async () => [{ name: "search_logs", description: "Search logs" }, { name: "update_issue" }],
  });
  const me: SlackMe = { id: "", name: "" };
  const extension = slackExtension(slack, me);
  const oncallExt = oncallExtension(gateway, me, "C_ON");
  const store = await Store.open({ ...t.options, extensions: [extension, oncallExt] });
  const watcher = (active: boolean) =>
    new SlackWatcher(store, slack, extension, me, {
      pollMs: 60_000,
      ignore: new Set(),
      oncall: { channel: "C_ON", extension: oncallExt, active: async () => active },
    });
  try {
    channel = [human(ts(5), "Karun", "U07", "before the shift")];
    await watcher(false).poll(); // off call: the channel is not read
    assert.throws(() => store.resolveSession("Slack"), /No session/);
    const on = watcher(true);
    channel = [];
    await on.poll(); // the shift starts now; earlier messages stay history
    channel = [
      human(ts(-30), "Karun", "U07", "before the shift"),
      pd(ts(6), "High", "Backlog_High"),
      pd(ts(7), "Low", "Latency_High"),
      human(ts(8), "Karun", "U07", "is image scanning down?"),
      human(ts(9), "Me Myself", "UME", "my own note"),
      "=== Message from Deploy (B054) at 2026-10-27 13:00:00 PDT === \nMessage TS: " + ts(10) + "\nDeployed\n\n",
    ];
    await on.poll();
    await on.poll();
    const session = store.resolveSession("Slack");
    const agents = (await store.agents(session)).filter((a) => a.id !== 1);
    assert.deepEqual(agents.map((a) => a.name).sort(), ["#ts-oncall · Karun", "Alert · Backlog_High"]);
    const h = store.harness(session);
    const tools = async (id: number) => (await (await h.conversation(id as never, ctx))!.agent(ctx)).tools.map((x) => x.name).sort();
    for (const a of agents) assert.deepEqual(await tools(a.id), ["draft_reply", "prod_read", "slack_read"]);
  } finally {
    await store.close();
    await t.cleanup();
  }

  // prod_read offers and runs only the allowlisted read tools.
  const prodRead = oncallExt.tools!.find((x) => x.name === "prod_read")!;
  const run = (args: Record<string, unknown>) =>
    (prodRead.execute as (a: unknown, api: unknown, c: unknown) => Promise<{ content: { text: string }[] }>)(args, {}, ctx);
  assert.match((await run({ server: "logs" })).content[0].text, /^## search_logs/);
  assert.doesNotMatch((await run({ server: "logs" })).content[0].text, /update_issue/);
  await assert.rejects(() => run({ server: "sentry", tool: "update_issue", args: {} }), /not allowed/);
  assert.equal((await run({ server: "logs", tool: "search_logs", args: {} })).content[0].text, "rows");
  assert.deepEqual(gatewayCalls, ["search_logs"]);
});
