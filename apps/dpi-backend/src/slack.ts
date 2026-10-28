// Personal Slack agent. A watcher polls Slack through the Roblox MCP Gateway for DMs and mentions of you, and gives each
// Slack thread (or DM) its own durable agent in the "Slack" session. The agent reads Slack and saves its reply as a Slack
// draft. It has no tool that sends: you review the draft in Slack and send it yourself.
import { execFile } from "node:child_process";
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
  /** Calls one Slack MCP tool and returns its text result; throws on a tool error. */
  call(tool: string, args: Record<string, unknown>): Promise<string>;
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

function run(cmd: string, args: string[], opts: { env?: Record<string, string>; input?: string } = {}) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { env: { ...process.env, ...opts.env }, timeout: 90_000, maxBuffer: 64 << 20 },
      (err, stdout, stderr) =>
        err ? reject(Error(`${cmd} ${args[0] ?? ""} failed: ${(stderr || err.message).trim().slice(0, 300)}`)) : resolve(stdout),
    );
    child.stdin?.end(opts.input ?? "");
  });
}

/**
 * Slack through the `mcp-gateway` CLI, with an LCA token exchanged from this machine's github.rbx.com login
 * (`gh auth login --hostname github.rbx.com`). curl and the CLI honour HTTPS_PROXY, which devspace services need.
 */
export function gatewaySlack(bin = process.env.DPI_SLACK_MCP_GATEWAY || "mcp-gateway"): SlackApi {
  let token = "";
  let mintedAt = 0;
  const mint = async () => {
    const ghe = (await run("gh", ["auth", "token", "--hostname", "github.rbx.com"])).trim();
    // The header comes from stdin so the GitHub token never shows in the process list.
    const body = await run("curl", ["-fsS", "--max-time", "30", "-H", "@-", EXCHANGE], {
      input: `Authorization: Bearer ${ghe}\n`,
    });
    token = (JSON.parse(body) as { token: string }).token;
    mintedAt = Date.now();
  };
  return {
    async call(tool, args) {
      for (let attempt = 0; ; attempt++) {
        if (!token || Date.now() - mintedAt > 15 * 60_000) await mint();
        try {
          const out = JSON.parse(
            await run(bin, ["-o", "json", "call", tool, JSON.stringify(args)], {
              env: { MCP_GATEWAY_TOKEN: token, MCP_GW_SERVER: "slack" },
            }),
          ) as { content?: { text?: string }[]; isError?: boolean };
          const text = (out.content ?? []).map((c) => c.text ?? "").join("");
          if (out.isError) throw Error(text.slice(0, 500) || `${tool} failed`);
          return text;
        } catch (e) {
          if (attempt) throw e;
          token = "";
        }
      }
    },
  };
}

/** Slack MCP results are JSON with the markdown under `results` or `result`. */
export function unwrap(text: string): string {
  try {
    const v = JSON.parse(text) as { results?: unknown; result?: unknown };
    return typeof v.results === "string" ? v.results : typeof v.result === "string" ? v.result : text;
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

/** Pacific date `days` ago as YYYY-MM-DD, the timezone Slack search dates use for this account. */
const pacificDay = (days: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(Date.now() - days * 86_400_000);

const prompt = (m: SlackMessage) =>
  [
    `New Slack ${isDirect(m) ? "message" : "mention"} from ${m.userName} (${m.user}) in ${m.channelName} (${m.channel}) at ${m.time}.`,
    `message_ts ${m.ts}${m.threadTs ? `, a reply in the thread with parent ts ${m.threadTs}` : ""}. ${m.permalink}`,
    "",
    m.text || "(No text in the search result. Read the message in Slack.)",
  ].join("\n");

export class SlackWatcher {
  private timer?: NodeJS.Timeout;
  private polling = false;

  constructor(
    private readonly store: Store,
    private readonly slack: SlackApi,
    private readonly extension: Extension,
    private readonly me: SlackMe,
    private readonly options: { pollMs: number; ignore: ReadonlySet<string> },
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
        const key = `${m.channel}:${m.ts}`;
        if (this.store.catalog.prepare("SELECT 1 FROM slack_seen WHERE key=?").get(key)) continue;
        await this.deliver(m);
        this.store.catalog.prepare("INSERT OR IGNORE INTO slack_seen VALUES(?,?)").run(key, Date.now());
      }
    } catch (e) {
      console.error("[slack]", e instanceof Error ? e.message : e);
    } finally {
      this.polling = false;
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

  private async deliver(m: SlackMessage) {
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
            extensions: policy ? [this.extension, policy] : [this.extension],
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
      this.store.setAgentName(row, c.id as number, `${m.channelName} · ${m.userName}`);
    }
    await this.store.send(c, { content: prompt(m), requestId: `slack:${m.channel}:${m.ts}` });
  }
}
