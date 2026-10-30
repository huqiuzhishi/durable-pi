import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Store } from "../src/store.js";
import { slackExtension, SlackWatcher, type SlackApi, type SlackMe } from "../src/slack.js";
import { parsePr, prReviewExtension, prStartExtension, PrReview, type GitHub } from "../src/pr-review.js";
import { tempStore, until } from "./helpers.js";

const URL = "https://github.rbx.com/Roblox/widgets/pull/7";

test("pr review: parse pull request links", () => {
  assert.deepEqual(parsePr(`please look <${URL}/files|#7>`), {
    host: "github.rbx.com",
    owner: "Roblox",
    repo: "widgets",
    number: 7,
    url: URL,
    key: "github.rbx.com/Roblox/widgets#7",
  });
  assert.equal(parsePr("https://github.rbx.com/Roblox/widgets/issues/7"), undefined);
});

test("pr review: one review agent per pull request, pending GitHub review only", async () => {
  const t = await tempStore();
  const now = Date.now() / 1000;
  const slack: SlackApi = {
    async call(tool, args) {
      if (tool === "slack_read_user_profile") return JSON.stringify({ result: "User ID: UME\nReal Name: Me Myself\n" });
      if (tool === "slack_send_message_draft") return JSON.stringify({ result: "ok" });
      const dm = String(args.filters).startsWith("to:") && polls > 1;
      return JSON.stringify({
        results: dm
          ? `## Messages (1 results)\n### Result 1 of 1\nChannel: DM (ID: D1)\nFrom: Ann (ID: U1) \nTime: now\nMessage_ts: ${(now + 5).toFixed(6)}\nPermalink: [link](https://x.slack.com/archives/D1/p1)\nText: \nplease review ${URL}\n---\n`
          : "## Messages (0 results)",
      });
    },
  };
  let polls = 0;
  let pending: { state: string; user: { login: string }; html_url?: string }[] = [];
  const posts: Record<string, unknown>[] = [];
  const ghCalls: string[] = [];
  const gh: GitHub = {
    async api(method, path, opts = {}) {
      ghCalls.push(`${method} ${path}`);
      if (path === "user") return { login: "me" };
      if (path === "repos/Roblox/widgets/pulls/7")
        return { title: "T", body: "", state: "open", user: { login: "ann" }, base: { ref: "main" }, head: { ref: "f", sha: "abc" }, additions: 5, deletions: 1, changed_files: 1, commits: 1 };
      if (path.endsWith("/reviews?per_page=100")) return pending;
      if (method === "POST" && path.endsWith("/reviews")) {
        const body = opts.body as Record<string, unknown>;
        posts.push(body);
        if ((body.comments as unknown[] | undefined)?.length) throw Error("gh api failed: HTTP 422 line must be part of the diff");
        return { html_url: "https://github.rbx.com/Roblox/widgets/pull/7#pullrequestreview-1" };
      }
      throw Error(`unexpected ${method} ${path}`);
    },
    diff: async () => "",
    git: async () => "",
    clone: async () => {},
  };
  const me: SlackMe = { id: "", name: "" };
  const slackExt = slackExtension(slack, me);
  const review = prReviewExtension(gh, slack, me, t.work);
  let watcher: SlackWatcher | undefined;
  const start = prStartExtension(me, (r) => watcher!.startReview(r));
  const store = await Store.open({ ...t.options, extensions: [slackExt, review, start] });
  try {
    watcher = new SlackWatcher(store, slack, slackExt, me, { pollMs: 60_000, ignore: new Set(), review: { extension: review, start } });
    polls++;
    await watcher.poll();
    polls++;
    await watcher.poll();
    const session = store.resolveSession("Slack");
    const h = store.harness(session);
    const named = async (name: string) => (await store.agents(session)).filter((a) => a.name === name);
    const conv = async (id: number) => (await h.conversation(id as never, ctx))!;
    const tools = async (id: number) => (await (await conv(id)).agent(ctx)).tools.map((x) => x.name).sort();
    const [dm] = await named("DM · Ann");
    assert.deepEqual(await tools(dm.id), ["draft_reply", "slack_read", "start_pr_review"]);

    // The thread agent hands the pull request to its own review agent; asking again reuses it.
    for (const n of [1, 2]) {
      const sub = await store.send(await conv(dm.id), { content: `review: ${URL}`, requestId: `t:${n}` });
      assert.equal((await store.settled(h, sub.id as number, 20_000)).status, "done");
    }
    const prs = await named("PR · widgets#7");
    assert.equal(prs.length, 1);
    const pr = prs[0];
    assert.deepEqual(await tools(pr.id), ["draft_reply", "pr_read", "repo_checkout", "repo_grep", "repo_ls", "repo_read", "save_review", "slack_read"]);
    const requests = async () =>
      (await store.activeEntries(await conv(pr.id))).filter((e) => (e as { kind?: string }).kind === "pi.user" && JSON.stringify(e).includes("Review request for")).length;
    await until(async () => (await requests()) === 2, 15000, "two review requests");

    // GitHub refuses an off-diff comment: the review is saved again with the comments in its body, still pending.
    const save = async (requestId: string) => {
      const comments = [{ path: "a.ts", line: 3, body: "bug" }];
      const body = JSON.stringify({ verdict: "request_changes", summary: "S", concerns: ["race"], comments });
      const sub = await store.send(await conv(pr.id), { content: `save: ${body}`, requestId });
      assert.equal((await store.settled(h, sub.id as number, 20_000)).status, "done");
      return (await h.snapshot(PrReview, pr.id as never, ctx))!;
    };
    let doc = await save("s:1");
    assert.equal(doc.reviewedSha, "abc");
    assert.equal(doc.reviews[0].status, "pending_on_github");
    assert.match(doc.reviews[0].note ?? "", /refused the inline comments/);
    assert.equal(posts.length, 2);
    assert.match(String(posts[1].body), /`a\.ts:3` bug/);
    assert.ok(posts.every((p) => !("event" in p) && p.commit_id === "abc"));

    // An unsubmitted pending review of yours is never overwritten.
    pending = [{ state: "PENDING", user: { login: "me" } }];
    doc = await save("s:2");
    assert.equal(doc.reviews[1].status, "not_saved");
    assert.equal(posts.length, 2);
    assert.ok(!ghCalls.some((c) => /merge|events|\/reviews\/\d+/.test(c)));
  } finally {
    watcher?.stop();
    await store.close();
    await t.cleanup();
  }
});
