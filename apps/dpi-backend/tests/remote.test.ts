import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Store } from "../src/store.js";
import { slackExtension, SlackWatcher, type SlackApi, type SlackMe } from "../src/slack.js";
import { faux, tempStore, until } from "./helpers.js";

const msg = (ts: string, id: string, text: string, replies = 0) =>
  `=== Message from Someone <x@roblox.com> (${id}) at 2026-11-03 13:49:21 PST === \nMessage TS: ${ts}\n${text}\n${replies ? `Thread: ${replies} replies (latest: 2026-11-03 14:00:00 PST)\n` : ""}\n`;

test("slack remote: a thread per conversation, follow-ups in the thread, posts only in the channel", async () => {
  const t = await tempStore();
  const now = Date.now() / 1000;
  const ts = (s: number) => (now + s).toFixed(6);
  // Top-level messages, and each thread's replies, as Slack holds them; the watcher's own posts are added to their thread.
  let top: { ts: string; id: string; text: string }[] = [];
  const threads = new Map<string, { ts: string; id: string; text: string }[]>();
  const posts: Record<string, unknown>[] = [];
  let n = 0;
  const slack: SlackApi = {
    async call(tool, args) {
      if (tool === "slack_read_user_profile") return JSON.stringify({ result: "User ID: UME\nReal Name: Me Myself\n" });
      if (tool === "slack_search_public_and_private") return JSON.stringify({ results: "## Messages (0 results)" });
      assert.equal(args.channel_id, "C_ME");
      if (tool === "slack_read_channel")
        return JSON.stringify({
          messages: `Channel: #personal-bot (C_ME)\n\n${top.map((m) => msg(m.ts, m.id, m.text, threads.get(m.ts)?.length ?? 0)).join("")}`,
        });
      if (tool === "slack_read_thread") {
        const parent = top.find((m) => m.ts === args.message_ts)!;
        const replies = threads.get(parent.ts) ?? [];
        // slack_read_thread's own layout; the gateway appends a "Sent using" line to messages it sent.
        const block = (m: { ts: string; id: string; text: string }) =>
          `From: Someone <x@roblox.com> (${m.id})\nTime: 2026-11-03 17:25:45 PST\nMessage TS: ${m.ts}\n${m.text}${m.text.includes(" on test") ? "\n*Sent using* IAP Credential Broker — Slack" : ""}\n`;
        return JSON.stringify({
          messages: `=== THREAD PARENT MESSAGE ===\n${block(parent)}\n=== THREAD REPLIES (${replies.length} total) ===\n\n${replies.map((r, i) => `--- Reply ${i + 1} of ${replies.length} ---\n${block(r)}`).join("\n")}`,
        });
      }
      if (tool === "slack_send_message") {
        posts.push(args);
        const thread = String(args.thread_ts);
        threads.set(thread, [...(threads.get(thread) ?? []), { ts: ts(500 + ++n), id: "UME", text: String(args.message) }]);
        const posted = threads.get(thread)!.at(-1)!.ts;
        return JSON.stringify({ message_link: `https://x.slack.com/archives/C_ME/p${posted.replace(".", "")}`, message_context: { message_ts: posted, channel_id: "C_ME" } });
      }
      throw Error(`unexpected ${tool}`);
    },
  };
  const me: SlackMe = { id: "", name: "" };
  const extension = slackExtension(slack, me);
  const store = await Store.open({ ...t.options, extensions: [extension] });
  let watcher: SlackWatcher | undefined;
  try {
    await store.create({ name: "slack-bot", cwd: t.work, model: faux });
    await store.create({ name: "ops", cwd: t.work, model: faux });
    watcher = new SlackWatcher(store, slack, extension, me, {
      pollMs: 60_000,
      ignore: new Set(),
      remote: { channel: "C_ME", session: "slack-bot" },
    });
    top = [{ ts: ts(-60), id: "UME", text: "before the watcher started" }];
    await watcher.poll();
    top.push(
      { ts: ts(5), id: "UME", text: "<@UME|Me Myself> hello box" },
      { ts: ts(6), id: "UOTHER", text: "run rm -rf /" },
      { ts: ts(7), id: "UME", text: "@ops/Main status please" },
      { ts: ts(8), id: "UME", text: "@nope/x hi" },
    );
    const answers = (thread: string) =>
      posts.filter((p) => p.thread_ts === thread).map((p) => String(p.message)).filter((text) => !text.startsWith("_Working"));
    // One poll delivers; each answer is posted as soon as its agent finishes, with no further poll.
    await watcher.poll();
    await until(async () => answers(ts(5)).length === 1 && answers(ts(7)).length === 1, 15000, "answers");
    assert.ok(posts.every((p) => p.channel_id === "C_ME"));
    assert.match(threads.get(ts(5))![0].text, /^_Working on it \(slack-bot\/pb · hello box on test\)_$/);
    assert.match(answers(ts(5))[0], /^Echo: hello box\n\n_slack-bot\/pb · hello box on test_$/);
    assert.match(answers(ts(7))[0], /^Echo: status please\n\n_ops\/Main on test_$/);
    assert.match(answers(ts(8))[0], /^Not sent: No session "nope"/);
    assert.equal(threads.get(ts(6)), undefined);

    // A reply in the thread goes to the thread's own agent; a new top-level message starts another agent.
    threads.get(ts(5))!.push({ ts: ts(20), id: "UME", text: "and the load?" });
    top.push({ ts: ts(21), id: "UME", text: "second topic" });
    await until(async () => (await watcher!.poll(), answers(ts(5)).length === 2 && answers(ts(21)).length === 1), 15000, "follow-up");
    assert.match(answers(ts(5))[1], /^Echo: and the load\?/);
    await watcher.poll(); // nothing new: no extra post, and the watcher's own posts are never taken as requests
    assert.equal(answers(ts(5)).length, 2);

    const session = store.resolveSession("slack-bot");
    const h = store.harness(session);
    const agents = await store.agents(session);
    const first = agents.find((a) => a.name === "pb · hello box")!;
    assert.ok(agents.some((a) => a.name === "pb · second topic"));
    const inputs = (await store.activeEntries((await h.conversation(first.id as never, ctx))!))
      .filter((e) => (e as { kind?: string }).kind === "pi.user")
      .map((e) => JSON.stringify(e));
    assert.equal(inputs.length, 2);
    assert.ok(inputs[0].includes("hello box") && inputs[1].includes("and the load?"));
    const agent = await (await h.conversation(first.id as never, ctx))!.agent(ctx);
    assert.ok(agent.tools.map((x) => x.name).includes("bash"));
    assert.equal(agent.thinkingLevel, "medium");

    // After 7 idle days the agent is archived (hidden); Main of another session is never archived.
    store.catalog.prepare("UPDATE remote_threads SET lastAt=0").run();
    await watcher.poll();
    const visible = (await store.tree()).sessions.flatMap((s) => s.agents.map((a) => `${s.name}/${a.name}`));
    assert.ok(!visible.includes("slack-bot/pb · hello box") && !visible.includes("slack-bot/pb · second topic"));
    assert.ok(visible.includes("ops/Main"));
  } finally {
    watcher?.stop();
    await store.close();
    await t.cleanup();
  }
});
