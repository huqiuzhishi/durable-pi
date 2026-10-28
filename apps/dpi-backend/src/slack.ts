// Personal Slack agent. A watcher polls Slack through the Roblox MCP Gateway for DMs and mentions of you, and gives each
// Slack thread (or DM) its own durable agent in the "Slack" session. The agent reads Slack and saves its reply as a Slack
// draft. It has no tool that sends: you review the draft in Slack and send it yourself.
// While PagerDuty shows you on call, it also answers new human messages and high-urgency PagerDuty alerts in your
// team's on-call channel. On-call agents can also read production logs and metrics; nothing they have writes.
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { Type } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  defineDoc,
  defineExtension,
  defineTool,
  section,
  type ConversationId,
  type Extension,
} from "@earendil-works/pi-durable";
import type { SessionRow, Store } from "./store.js";

export interface SlackApi {
  /** Calls one MCP gateway tool and returns its text result; throws on a tool error. */
  call(tool: string, args: Record<string, unknown>): Promise<string>;
  listTools?(): Promise<{ name: string; description?: string }[]>;
}

export type SlackMe = { id: string; name: string };

export type SlackMessage = {
  channel: string;
  channelName: string;
  user: string;
  userName: string;
  bot: boolean;
  ts: string;
  /** Parent message of the thread this message replies in; absent for top-level messages. */
  threadTs?: string;
  time: string;
  permalink: string;
  text: string;
};

/** The Slack thread (or DM) a conversation answers, and every draft it saved. */
export const SlackThread = defineDoc<{
  channel: string;
  channelName: string;
  threadTs: string | null;
  drafts: { at: number; text: string; status: "saved" | "not_saved"; note?: string }[];
}>({
  kind: "slack.thread",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ channel: "", channelName: "", threadTs: null, drafts: [] }),
});

const EXCHANGE = "https://llm-gateway.simulprod.com/sapi-authorization/v1/lca/ghe-exchange?aud=rbx.prod.mcp-gateway";

function run(cmd: string, args: string[], opts: { env?: Record<string, string>; input?: string; cwd?: string } = {}) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { env: { ...process.env, ...opts.env }, cwd: opts.cwd, timeout: 90_000, maxBuffer: 64 << 20 },
      (err, stdout, stderr) =>
        err ? reject(Error(`${cmd} ${args[0] ?? ""} failed: ${(stderr || err.message).trim().slice(0, 300)}`)) : resolve(stdout),
    );
    child.stdin?.end(opts.input ?? "");
  });
}

/** A tool's own error answer: retrying or minting a new token does not help. */
class GatewayToolError extends Error {}

const lca = { token: "", mintedAt: 0 };

/** An LCA token for the MCP gateway, exchanged from this machine's github.rbx.com login and shared by every server. */
async function gatewayToken() {
  if (lca.token && Date.now() - lca.mintedAt < 15 * 60_000) return lca.token;
  const ghe = (await run("gh", ["auth", "token", "--hostname", "github.rbx.com"])).trim();
  // The header comes from stdin so the GitHub token never shows in the process list.
  const body = await run("curl", ["-fsS", "--max-time", "30", "-H", "@-", EXCHANGE], {
    input: `Authorization: Bearer ${ghe}\n`,
  });
  Object.assign(lca, { token: (JSON.parse(body) as { token: string }).token, mintedAt: Date.now() });
  return lca.token;
}

/**
 * One MCP gateway server through the `mcp-gateway` CLI (`gh auth login --hostname github.rbx.com` must have run).
 * curl and the CLI honour HTTPS_PROXY, which devspace services need. Rate limits are retried after a pause.
 */
export function gatewayClient(server: string, bin = process.env.DPI_SLACK_MCP_GATEWAY || "mcp-gateway"): SlackApi {
  const cli = async (args: string[]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run(bin, ["-o", "json", ...args], {
          env: { MCP_GATEWAY_TOKEN: await gatewayToken(), MCP_GW_SERVER: server },
        });
      } catch (e) {
        if (attempt >= 2) throw e;
        if (/Too Many Requests|\b429\b/.test(String(e))) await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
        else lca.token = "";
      }
    }
  };
  return {
    async call(tool, args) {
      const out = JSON.parse(await cli(["call", tool, JSON.stringify(args)])) as {
        content?: { text?: string }[];
        isError?: boolean;
      };
      const text = (out.content ?? []).map((c) => c.text ?? "").join("");
      if (out.isError) throw new GatewayToolError(text.slice(0, 500) || `${tool} failed`);
      return text;
    },
    async listTools() {
      return JSON.parse(await cli(["list-tools"])) as { name: string; description?: string }[];
    },
  };
}

export const gatewaySlack = () => gatewayClient("slack");

/** Slack MCP results are JSON with the markdown under `results`, `result` or `messages`. */
export function unwrap(text: string): string {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    const body = [v.results, v.result, v.messages].find((x) => typeof x === "string");
    return typeof body === "string" ? body : text;
  } catch {
    return text;
  }
}

function messageText(block: string) {
  const start = block.indexOf("\nText:");
  if (start < 0) return "";
  const rest = block.slice(start + "\nText:".length);
  const ends = ["\nContext before:", "\nContext after:", "\n---"].map((m) => rest.indexOf(m)).filter((i) => i >= 0);
  return rest.slice(0, ends.length ? Math.min(...ends) : undefined).trim();
}

/** The messages of a slack_search_public_and_private result. */
export function parseSearch(text: string): SlackMessage[] {
  return unwrap(text)
    .split(/^### Result \d+ of \d+[ \t]*$/m)
    .slice(1)
    .flatMap((block) => {
      const channel = block.match(/^Channel: (.*) \(ID: (\w+)\)/m);
      const from = block.match(/^From: (.*?) \(ID: (\w+)\)(.*)$/m);
      const ts = block.match(/^Message_ts: ([\d.]+)/m)?.[1];
      if (!channel || !from || !ts) return [];
      const permalink = block.match(/^Permalink: \[link\]\((.*?)\)/m)?.[1] ?? "";
      const threadTs = permalink.match(/[?&]thread_ts=([\d.]+)/)?.[1];
      return [
        {
          channel: channel[2],
          channelName: channel[1].trim(),
          user: from[2],
          userName: from[1].replace(/\s*<[^>]*>/, "").trim() || from[2],
          bot: from[3].includes("[BOT]"),
          ts,
          ...(threadTs && threadTs !== ts ? { threadTs } : {}),
          time: block.match(/^Time: (.+)$/m)?.[1]?.trim() ?? "",
          permalink,
          text: messageText(block),
        },
      ];
    });
}

/** The top-level messages of a slack_read_channel result. */
export function parseChannel(text: string, channel: string): SlackMessage[] {
  const body = unwrap(text);
  const channelName = body.match(/^Channel: (\S+)/m)?.[1] ?? channel;
  return body
    .split(/^=== Message from /m)
    .slice(1)
    .flatMap((block) => {
      const head = block.match(/^(.*?) \((\w+)\) at (.+?) ===/);
      const ts = block.match(/^Message TS: ([\d.]+)/m)?.[1];
      if (!head || !ts) return [];
      const email = head[1].match(/<([^>]*)>/)?.[1] ?? "";
      const after = block.slice(block.indexOf("\n", block.indexOf("Message TS:")) + 1);
      return [
        {
          channel,
          channelName,
          user: head[2],
          userName: head[1].replace(/\s*<[^>]*>/, "").trim() || head[2],
          bot: head[2].startsWith("B") || email.endsWith("@slack-bots.com"),
          ts,
          time: head[3].trim(),
          permalink: "",
          text: after.split(/\n(?:Reactions|Files|Thread): /)[0].trim(),
        },
      ];
    });
}

export const isHighUrgencyAlert = (m: SlackMessage) =>
  m.bot && m.userName === "PagerDuty" && /\*Urgency:\*\s*High\b/i.test(m.text);

const isDirect = (m: SlackMessage) => m.channelName === "DM" || m.channelName === "Group DM";

const READ_TOOLS = [
  "slack_read_thread",
  "slack_read_channel",
  "slack_read_user_profile",
  "slack_search_public_and_private",
  "slack_search_users",
  "slack_search_channels",
] as const;

export function slackExtension(slack: SlackApi, me: SlackMe): Extension {
  const read = defineTool({
    name: "slack_read",
    description:
      "Read Slack. Read only. `tool` picks the Slack tool and `args` are its arguments: slack_read_thread {channel_id, message_ts} (the thread's parent ts), slack_read_channel {channel_id, limit}, slack_read_user_profile {user_id}, slack_search_public_and_private {keywords: [...], filters: \"in:<#C123> from:<@U123> after:YYYY-MM-DD\", natural_language_query: \"\"}, slack_search_users {query}, slack_search_channels {query}.",
    parameters: Type.Object({
      tool: Type.Union(READ_TOOLS.map((t) => Type.Literal(t))),
      args: Type.Record(Type.String(), Type.Unknown()),
    }),
    replay: "safe",
    execute: async (a) => ({
      content: [{ type: "text", text: unwrap(await slack.call(a.tool, a.args)).slice(0, 60_000) }],
    }),
  });
  // No replay policy: a crash mid-call returns an interrupted result instead of saving a second draft.
  const draft = defineTool({
    name: "draft_reply",
    description:
      "Save your reply as a Slack draft in this conversation's Slack thread or DM. It never sends: the user reviews the draft in Slack and sends it. Slack keeps one draft per channel, so when one already exists the text is kept here instead.",
    parameters: Type.Object({ text: Type.String({ description: "The reply, in Slack markdown." }) }),
    execute: async (a, api, ctx) => {
      const thread = await api.snapshot(SlackThread, api.conversationId, ctx);
      if (!thread?.channel) throw Error("This conversation has no Slack thread");
      let note: string | undefined;
      try {
        await slack.call("slack_send_message_draft", {
          channel_id: thread.channel,
          message: a.text,
          ...(thread.threadTs ? { thread_ts: thread.threadTs } : {}),
        });
      } catch (e) {
        note = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      }
      await api.commit(async (tx) => {
        (await tx.doc(SlackThread, api.conversationId)).drafts.push({
          at: Date.now(),
          text: a.text,
          status: note ? "not_saved" : "saved",
          ...(note ? { note } : {}),
        });
      }, ctx);
      return {
        content: [
          {
            type: "text",
            text: note
              ? `Slack did not save the draft (${note}). The text is kept in this conversation for ${me.name} to copy.`
              : `Draft saved in Slack (${thread.channelName}). ${me.name} reviews and sends it.`,
          },
        ],
      };
    },
  });
  return defineExtension({
    name: "slack",
    tools: [read, draft],
    sections: [
      section(
        "slack",
        () =>
          `You draft Slack replies for ${me.name} (Slack user ${me.id}). You never send: draft_reply saves a draft that ${me.name} reviews and sends. Each new message in this thread or DM arrives as its own request.
For each message:
1. Read the context with slack_read: the whole thread (slack_read_thread with the thread's parent ts) or the recent DM history (slack_read_channel).
2. Decide whether ${me.name} needs to reply. No reply is needed for FYIs, automated notices, thanks, or when ${me.name} already answered after this message. Then do not draft; say why in one line.
3. Otherwise call draft_reply once, in ${me.name}'s voice: short, direct, specific, no filler greeting. Use only facts from Slack. Never invent commitments, dates or numbers; when a fact is missing, draft a short holding reply or a clarifying question.
End with one line: what you drafted or why you did not.`,
        { tag: false },
      ),
    ],
  });
}

/** Gateway tools an on-call agent may call. Only tools that read: Sentry's create, update and Seer tools are left out. */
export const PROD_TOOLS = {
  logs: ["search_logs", "aggregate_logs", "get_data_view_fields", "get_log_entry", "analyze_field", "query_with_lucene", "list_data_views", "get_log_patterns"],
  grafana: ["search_dashboards", "list_alert_rules", "export_dashboard", "get_dashboard_panel", "list_datasources", "get_datasource", "list_folders", "get_alert_rule", "get_dashboard"],
  victoriametrics: ["list_label_values", "query", "list_clusters", "query_range", "list_labels"],
  sentry: ["whoami", "find_organizations", "find_teams", "find_projects", "find_releases", "get_issue_tag_values", "get_replay_details", "search_events", "find_dsns", "search_docs", "get_doc", "search_issues", "search_issue_events", "get_profile_details", "get_sentry_resource"],
} as const;
type ProdServer = keyof typeof PROD_TOOLS;

export function oncallExtension(gateway: (server: ProdServer) => SlackApi, me: SlackMe, channel: string): Extension {
  const servers = Object.keys(PROD_TOOLS) as ProdServer[];
  const prodRead = defineTool({
    name: "prod_read",
    description:
      "Read production logs (logs: Kibana), dashboards and alert rules (grafana), metrics (victoriametrics: PromQL) and errors (sentry). Read only. Without `tool`, lists the server's tools with their arguments; call that first. Time bounds in args are UTC.",
    parameters: Type.Object({
      server: Type.Union(servers.map((s) => Type.Literal(s))),
      tool: Type.Optional(Type.String()),
      args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    replay: "safe",
    execute: async (a) => {
      const allowed: readonly string[] = PROD_TOOLS[a.server];
      const client = gateway(a.server);
      if (!a.tool) {
        const tools = (await client.listTools?.()) ?? [];
        const text = tools
          .filter((t) => allowed.includes(t.name))
          .map((t) => `## ${t.name}\n${t.description ?? ""}`)
          .join("\n\n");
        return { content: [{ type: "text", text: text.slice(0, 60_000) || "No tools" }] };
      }
      if (!allowed.includes(a.tool))
        throw Error(`${a.server} ${a.tool} is not allowed. Read-only tools: ${allowed.join(", ")}`);
      return { content: [{ type: "text", text: (await client.call(a.tool, a.args ?? {})).slice(0, 60_000) }] };
    },
  });
  return defineExtension({
    name: "oncall",
    tools: [prodRead],
    sections: [
      section(
        "oncall",
        () =>
          `${me.name} is on call, and you are their on-call assistant for the team channel <#${channel}>. You cannot acknowledge, resolve, silence or change anything, and you never claim you did.
For a high-urgency PagerDuty alert:
1. Read the alert and its thread (slack_read_thread with the alert's ts). If someone already explained or handled it, do not draft; say so in one line.
2. Find what fired and since when: the Grafana alert rule, its metric (victoriametrics query_range), error logs (logs), and Sentry issues for the service. Call prod_read without a tool to learn a server's arguments. Query bounds are UTC; write times in Pacific time with PT.
3. Look for earlier alerts with the same name in the channel (slack_read search, filters "in:<#${channel}>") and how they were resolved.
4. Call draft_reply once in the alert thread, at most 12 lines: what fired and when, current state, impact, the likely cause with evidence (numbers, links), similar earlier alerts, and a suggested next step. Say what you did not verify.
For a human message in the channel: answer or triage it, with the same tools when production data helps, then draft the reply.`,
        { tag: false },
      ),
    ],
  });
}

/** Whether `name` is on call in a PagerDuty escalation policy, through the read-only PagerDuty skill CLI. */
export function pagerdutyOnCall(cli: string, policy: string, name: () => string) {
  return async () => {
    const out = await run("uv", ["run", "--quiet", cli, "oncalls", "--policy", policy], { cwd: tmpdir() });
    return out.split("\n").some((line) => line.startsWith(`${name()}  level=`));
  };
}

/** Pacific date `days` ago as YYYY-MM-DD, the timezone Slack search dates use for this account. */
const pacificDay = (days: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(Date.now() - days * 86_400_000);

type Kind = "direct" | "oncall" | "alert";

const prompt = (m: SlackMessage, kind: Kind) =>
  [
    kind === "alert"
      ? `New high-urgency PagerDuty alert in ${m.channelName} (${m.channel}) at ${m.time}. Triage it.`
      : kind === "oncall"
        ? `New message in the on-call channel from ${m.userName} (${m.user}) in ${m.channelName} (${m.channel}) at ${m.time}.`
        : `New Slack ${isDirect(m) ? "message" : "mention"} from ${m.userName} (${m.user}) in ${m.channelName} (${m.channel}) at ${m.time}.`,
    `message_ts ${m.ts}${m.threadTs ? `, a reply in the thread with parent ts ${m.threadTs}` : ""}. ${m.permalink}`,
    "",
    m.text || "(No text in the search result. Read the message in Slack.)",
  ].join("\n");

export class SlackWatcher {
  private timer?: NodeJS.Timeout;
  private polling = false;
  private onCall = { active: false, checkedAt: 0 };

  constructor(
    private readonly store: Store,
    private readonly slack: SlackApi,
    private readonly extension: Extension,
    private readonly me: SlackMe,
    private readonly options: {
      pollMs: number;
      ignore: ReadonlySet<string>;
      oncall?: { channel: string; extension: Extension; active: () => Promise<boolean> };
    },
  ) {
    store.catalog.exec(`CREATE TABLE IF NOT EXISTS slack_threads(sessionId TEXT NOT NULL,key TEXT NOT NULL,conversationId INTEGER NOT NULL,PRIMARY KEY(sessionId,key));
      CREATE TABLE IF NOT EXISTS slack_seen(key TEXT PRIMARY KEY,at INTEGER NOT NULL);`);
  }

  start() {
    this.timer = setInterval(() => void this.poll(), this.options.pollMs);
    void this.poll();
  }

  stop() {
    clearInterval(this.timer);
  }

  private meta(key: string) {
    return (this.store.catalog.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)
      ?.value;
  }

  private setMeta(key: string, value: string) {
    this.store.catalog.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(key, value);
  }

  private async identify() {
    const profile = unwrap(await this.slack.call("slack_read_user_profile", {}));
    const id = profile.match(/^User ID: (\S+)/m)?.[1];
    if (!id) throw Error("The Slack profile has no user id");
    this.me.id = id;
    this.me.name = profile.match(/^Real Name: (.+)$/m)?.[1]?.trim() || id;
    // Only messages after the watcher first ran get drafts; older ones are history, not work.
    if (!this.meta("slack_since")) this.setMeta("slack_since", String(Date.now() / 1000));
    console.log(`[slack] watching DMs and mentions of ${this.me.name} (${id}) every ${this.options.pollMs / 1000}s`);
  }

  /** One pass: find new DMs and mentions, and hand each to its thread's agent once. */
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      if (!this.me.id) await this.identify();
      const search = async (keywords: string[], filters: string) =>
        parseSearch(
          await this.slack.call("slack_search_public_and_private", {
            keywords,
            filters,
            natural_language_query: "",
            limit: 20,
          }),
        );
      // Search returns at most 20 results. DMs come newest first; mentions come by relevance, so one day per query.
      const mention = `<@${this.me.id}>`;
      const found = (
        await Promise.all([
          search([], `to:${mention} after:${pacificDay(2)}`),
          search([mention], `on:${pacificDay(0)}`),
          search([mention], `on:${pacificDay(1)}`),
        ])
      ).flat();
      const since = Number(this.meta("slack_since"));
      for (const m of found.sort((a, b) => Number(a.ts) - Number(b.ts))) {
        if (Number(m.ts) <= since || m.bot || m.user === this.me.id) continue;
        if (this.options.ignore.has(m.channel) || this.options.ignore.has(m.user)) continue;
        await this.once(m, "direct");
      }
      await this.pollOnCall();
    } catch (e) {
      console.error("[slack]", e instanceof Error ? e.message : e);
    } finally {
      this.polling = false;
    }
  }

  private async once(m: SlackMessage, kind: Kind) {
    const key = `${m.channel}:${m.ts}`;
    if (this.store.catalog.prepare("SELECT 1 FROM slack_seen WHERE key=?").get(key)) return;
    await this.deliver(m, kind);
    this.store.catalog.prepare("INSERT OR IGNORE INTO slack_seen VALUES(?,?)").run(key, Date.now());
  }

  /** While PagerDuty shows you on call: new human messages and high-urgency alerts in the on-call channel. */
  private async pollOnCall() {
    const oncall = this.options.oncall;
    if (!oncall) return;
    if (Date.now() - this.onCall.checkedAt > 10 * 60_000) {
      try {
        const active = await oncall.active();
        if (active !== this.onCall.active) console.log(`[slack] on call: ${active ? "yes" : "no"}`);
        this.onCall = { active, checkedAt: Date.now() };
      } catch (e) {
        // A PagerDuty outage keeps the last answer and asks again next poll.
        console.error("[slack] on-call check:", e instanceof Error ? e.message : e);
      }
    }
    // Each shift starts fresh: messages from before it began are history, not work.
    if (!this.onCall.active) return void this.store.catalog.prepare("DELETE FROM meta WHERE key='slack_oncall_since'").run();
    let since = Number(this.meta("slack_oncall_since"));
    if (!since) this.setMeta("slack_oncall_since", String((since = Date.now() / 1000)));
    const messages = parseChannel(
      await this.slack.call("slack_read_channel", { channel_id: oncall.channel, limit: 20 }),
      oncall.channel,
    );
    for (const m of messages.sort((a, b) => Number(a.ts) - Number(b.ts))) {
      if (Number(m.ts) <= since || m.user === this.me.id || this.options.ignore.has(m.user)) continue;
      const alert = isHighUrgencyAlert(m);
      if (m.bot && !alert) continue;
      await this.once(m, alert ? "alert" : "oncall");
    }
  }

  private async session(): Promise<SessionRow> {
    const id = this.meta("slack_session");
    const row = id ? this.store.list().find((r) => r.id === id) : undefined;
    if (row) return row;
    const created = await this.store.create({
      name: "Slack",
      cwd: this.store.startDirs[0],
      model: this.store.routedModel(),
    });
    this.setMeta("slack_session", created.id);
    return this.store.row(created.id);
  }

  private async deliver(m: SlackMessage, kind: Kind) {
    const row = await this.session();
    const h = this.store.harness(row);
    // Channel mentions are answered in the mention's thread; a DM without a thread is one ongoing conversation.
    const threadTs = m.threadTs ?? (isDirect(m) ? undefined : m.ts);
    const key = threadTs ? `${m.channel}:${threadTs}` : m.channel;
    const known = this.store.catalog
      .prepare("SELECT conversationId FROM slack_threads WHERE sessionId=? AND key=?")
      .get(row.id, key) as { conversationId: number } | undefined;
    let c = known ? await h.conversation(known.conversationId as ConversationId, ctx) : undefined;
    if (!c) {
      const policy = this.store.opened.get(row.id)?.policy;
      c = await h.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: {
            model: { provider: row.provider, modelId: row.model },
            cwd: row.cwd,
            thinkingLevel: "low",
            extensions: [
              this.extension,
              ...(kind !== "direct" && this.options.oncall ? [this.options.oncall.extension] : []),
              ...(policy ? [policy] : []),
            ],
          },
          init: async (tx, id) => {
            Object.assign(await tx.doc(SlackThread, id), {
              channel: m.channel,
              channelName: m.channelName,
              threadTs: threadTs ?? null,
            });
          },
        },
        ctx,
      );
      this.store.catalog
        .prepare("INSERT OR REPLACE INTO slack_threads VALUES(?,?,?)")
        .run(row.id, key, c.id as number);
      const alertName = m.text.match(/Alert: ([^|>*]+)/)?.[1]?.trim() ?? m.text.match(/\|([^>]+)>/)?.[1] ?? "alert";
      this.store.setAgentName(
        row,
        c.id as number,
        kind === "alert" ? `Alert · ${alertName.slice(0, 60)}` : `${m.channelName} · ${m.userName}`,
      );
    }
    await this.store.send(c, { content: prompt(m, kind), requestId: `slack:${m.channel}:${m.ts}` });
  }
}
