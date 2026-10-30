// PR reviews for the personal Slack agent. A Slack thread agent calls start_pr_review when someone asks you to review a
// GitHub pull request; each pull request gets one review agent in the Slack session. The review agent reads the pull
// request through the GitHub API (and, for large ones, a read-only view of a local clone in ~/git/<repo>), then saves
// its comments as a pending GitHub review: only you see it until you submit it in GitHub. It has no tool that submits,
// approves, merges or pushes.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section, type Extension } from "@earendil-works/pi-durable";
import { run, slackTools, SlackThread, type SlackApi, type SlackMe } from "./slack.js";

export type PrRef = { host: string; owner: string; repo: string; number: number; url: string; key: string };

export function parsePr(text: string): PrRef | undefined {
  const m = text.match(/https?:\/\/([\w.-]+)\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  if (!m) return undefined;
  const [, host, owner, repo, n] = m;
  return { host, owner, repo, number: Number(n), url: `https://${host}/${owner}/${repo}/pull/${n}`, key: `${host}/${owner}/${repo}#${n}` };
}

export interface GitHub {
  /** One REST call. `raw` returns the body text (file contents); otherwise parsed JSON. */
  api(method: "GET" | "POST", path: string, opts?: { body?: unknown; raw?: boolean }): Promise<unknown>;
  diff(pr: PrRef): Promise<string>;
  git(cwd: string, args: string[]): Promise<string>;
  clone(pr: PrRef, dir: string): Promise<void>;
}

/** GitHub through this machine's `gh` login. */
export function ghCli(): GitHub {
  return {
    async api(method, path, opts = {}) {
      const host = path.startsWith("https://") ? [] : ["--hostname", process.env.DPI_PR_GH_HOST || "github.rbx.com"];
      const out = await run(
        "gh",
        [
          "api",
          ...host,
          "--method",
          method,
          ...(opts.raw ? ["-H", "Accept: application/vnd.github.raw"] : []),
          ...(opts.body ? ["--input", "-"] : []),
          path,
        ],
        opts.body ? { input: JSON.stringify(opts.body) } : {},
      );
      return opts.raw ? out : out.trim() ? JSON.parse(out) : null;
    },
    diff: (pr) => run("gh", ["pr", "diff", pr.url]),
    git: (cwd, args) => run("git", args, { cwd }),
    async clone(pr, dir) {
      await run("gh", ["repo", "clone", `${pr.host}/${pr.owner}/${pr.repo}`, dir, "--", "--filter=blob:none"], {
        timeoutMs: 15 * 60_000,
      });
    },
  };
}

type Verdict = "approve" | "comment" | "request_changes";
type ReviewComment = { path: string; line: number; side?: "RIGHT" | "LEFT"; start_line?: number; body: string };

/** The pull request a review agent reviews, its read-only checkout, and every review it saved. */
export const PrReview = defineDoc<{
  url: string;
  checkout: { dir: string; sha: string } | null;
  reviewedSha: string | null;
  reviews: {
    at: number;
    sha: string;
    verdict: Verdict;
    summary: string;
    concerns: string[];
    comments: ReviewComment[];
    status: "pending_on_github" | "not_saved";
    reviewUrl?: string;
    note?: string;
  }[];
}>({
  kind: "pr.review",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ url: "", checkout: null, reviewedSha: null, reviews: [] }),
});

type Pull = {
  title: string;
  body: string | null;
  state: string;
  draft?: boolean;
  user: { login: string };
  base: { ref: string };
  head: { ref: string; sha: string };
  additions: number;
  deletions: number;
  changed_files: number;
  commits: number;
};

const PAGE = 50_000;
const paged = (text: string, page = 1) => {
  const pages = Math.max(1, Math.ceil(text.length / PAGE));
  const n = Math.min(Math.max(1, Math.floor(page)), pages);
  const body = text.slice((n - 1) * PAGE, n * PAGE);
  return pages > 1 ? `(page ${n} of ${pages})\n${body}` : body;
};
const numbered = (text: string, from = 1, to = from + 399) =>
  text
    .split("\n")
    .slice(from - 1, Math.min(to, from + 799))
    .map((line, i) => `${from + i}\t${line}`)
    .join("\n");
const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);

export function prReviewExtension(
  gh: GitHub,
  slack: SlackApi,
  me: SlackMe,
  cloneRoot: string,
): Extension {
  let login = "";
  type Api = Parameters<NonNullable<Parameters<typeof defineTool>[0]["execute"]>>[1];
  type Ctx = Parameters<NonNullable<Parameters<typeof defineTool>[0]["execute"]>>[2];
  const context = async (api: Api, ctx: Ctx) => {
    const doc = await api.snapshot(PrReview, api.conversationId, ctx);
    const pr = doc?.url ? parsePr(doc.url) : undefined;
    if (!doc || !pr) throw Error("This conversation has no pull request");
    const base = `repos/${pr.owner}/${pr.repo}`;
    const pull = (await gh.api("GET", `${base}/pulls/${pr.number}`)) as Pull;
    return { doc, pr, base, pull };
  };
  const checkout = async (api: Api, ctx: Ctx) => {
    const doc = await api.snapshot(PrReview, api.conversationId, ctx);
    if (!doc?.checkout) throw Error("Call repo_checkout first");
    return doc.checkout;
  };

  const prRead = defineTool({
    name: "pr_read",
    description:
      "Read this pull request on GitHub. Read only. overview: title, author, branches, head sha, size, description and the sha you last reviewed. files: changed files with line counts. diff: the full diff. since_last_review: the diff from the commit you last reviewed to the head. comments: reviews and comments so far. checks: CI results at the head. file: one file at the head (path required), with line numbers. Long results come in pages.",
    parameters: Type.Object({
      what: Type.Union(
        ["overview", "files", "diff", "since_last_review", "comments", "checks", "file"].map((w) => Type.Literal(w)),
      ),
      path: Type.Optional(Type.String({ description: "file: the path in the repository" })),
      page: Type.Optional(Type.Number({ description: "Page of a long result, from 1" })),
    }),
    replay: "safe",
    execute: async (a, api, ctx) => {
      const { doc, pr, base, pull } = await context(api, ctx);
      const n = pr.number;
      switch (a.what) {
        case "overview":
          return textResult(
            JSON.stringify(
              {
                url: pr.url,
                title: pull.title,
                author: pull.user.login,
                state: pull.state,
                draft: !!pull.draft,
                base: pull.base.ref,
                head: pull.head.ref,
                headSha: pull.head.sha,
                additions: pull.additions,
                deletions: pull.deletions,
                changedFiles: pull.changed_files,
                commits: pull.commits,
                reviewedSha: doc.reviewedSha,
                description: (pull.body ?? "").slice(0, 8000),
              },
              null,
              1,
            ),
          );
        case "files": {
          const files = (await gh.api("GET", `${base}/pulls/${n}/files?per_page=100&page=${a.page ?? 1}`)) as {
            filename: string;
            status: string;
            additions: number;
            deletions: number;
          }[];
          return textResult(files.map((f) => `${f.status} ${f.filename} +${f.additions} -${f.deletions}`).join("\n") || "No more files");
        }
        case "diff":
          return textResult(paged(await gh.diff(pr), a.page));
        case "since_last_review": {
          if (!doc.reviewedSha) return textResult("You have not reviewed this pull request before; read the full diff.");
          if (doc.reviewedSha === pull.head.sha) return textResult("No new commits since your last review.");
          const compare = (await gh.api("GET", `${base}/compare/${doc.reviewedSha}...${pull.head.sha}`)) as {
            files?: { filename: string; patch?: string }[];
          };
          const text = (compare.files ?? []).map((f) => `--- ${f.filename}\n${f.patch ?? "(no patch)"}`).join("\n\n");
          return textResult(paged(text || "No file changes since your last review.", a.page));
        }
        case "comments": {
          const [reviews, inline, issue] = (await Promise.all([
            gh.api("GET", `${base}/pulls/${n}/reviews?per_page=100`),
            gh.api("GET", `${base}/pulls/${n}/comments?per_page=100`),
            gh.api("GET", `${base}/issues/${n}/comments?per_page=100`),
          ])) as { user?: { login: string }; state?: string; body?: string; path?: string; line?: number }[][];
          const short = (s?: string) => (s ?? "").replace(/\s+/g, " ").slice(0, 500);
          const text = [
            ...reviews.filter((r) => r.state !== "PENDING").map((r) => `review ${r.user?.login} ${r.state}: ${short(r.body)}`),
            ...inline.map((c) => `${c.user?.login} on ${c.path}:${c.line ?? "?"}: ${short(c.body)}`),
            ...issue.map((c) => `${c.user?.login}: ${short(c.body)}`),
          ].join("\n");
          return textResult(paged(text || "No comments yet.", a.page));
        }
        case "checks": {
          const runs = (await gh.api("GET", `${base}/commits/${pull.head.sha}/check-runs?per_page=100`)) as {
            check_runs: { name: string; status: string; conclusion: string | null }[];
          };
          return textResult(
            runs.check_runs.map((r) => `${r.name}: ${r.conclusion ?? r.status}`).join("\n") || "No checks at the head.",
          );
        }
        case "file": {
          if (!a.path) throw Error("file needs a path");
          const text = (await gh.api("GET", `${base}/contents/${encodeURI(a.path)}?ref=${pull.head.sha}`, {
            raw: true,
          })) as string;
          return textResult(numbered(text, 1, 2000));
        }
      }
      throw Error(`Unknown pr_read ${a.what}`);
    },
  });

  const repoCheckout = defineTool({
    name: "repo_checkout",
    description: `For a substantial pull request: clone the repository to ${cloneRoot}/<repo> when there is no clone yet, and fetch the pull request head. Read only: it never changes the working tree, so an existing clone keeps its branch and local changes. Then use repo_read, repo_grep and repo_ls, which read at the head commit.`,
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_a, api, ctx) => {
      const { pr, pull } = await context(api, ctx);
      const dir = join(cloneRoot, pr.repo);
      let cloned = false;
      if (!existsSync(join(dir, ".git"))) {
        if (existsSync(dir)) throw Error(`${dir} exists but is not a git clone`);
        await gh.clone(pr, dir);
        cloned = true;
      } else {
        const origin = (await gh.git(dir, ["remote", "get-url", "origin"])).trim();
        if (!origin.toLowerCase().includes(`${pr.owner}/${pr.repo}`.toLowerCase()))
          throw Error(`${dir} is a clone of ${origin}, not ${pr.owner}/${pr.repo}`);
      }
      await gh.git(dir, ["fetch", "--quiet", "origin", `pull/${pr.number}/head`]);
      await gh.git(dir, ["cat-file", "-e", `${pull.head.sha}^{commit}`]);
      await api.commit(async (tx) => {
        (await tx.doc(PrReview, api.conversationId)).checkout = { dir, sha: pull.head.sha };
      }, ctx);
      return textResult(`${cloned ? "Cloned" : "Using"} ${dir}; reading at ${pull.head.sha}. The working tree was not changed.`);
    },
  });

  const repoRead = defineTool({
    name: "repo_read",
    description: "Read a file at the pull request head from the checkout, with line numbers (at most 800 lines per call).",
    parameters: Type.Object({
      path: Type.String(),
      from: Type.Optional(Type.Number({ description: "First line, from 1" })),
      to: Type.Optional(Type.Number({ description: "Last line" })),
    }),
    replay: "safe",
    execute: async (a, api, ctx) => {
      const { dir, sha } = await checkout(api, ctx);
      return textResult(numbered(await gh.git(dir, ["show", `${sha}:${a.path.replace(/^\.?\//, "")}`]), a.from ?? 1, a.to));
    },
  });

  const repoGrep = defineTool({
    name: "repo_grep",
    description: "Search the repository at the pull request head (extended regex), optionally under one path. At most 300 matches.",
    parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }),
    replay: "safe",
    execute: async (a, api, ctx) => {
      const { dir, sha } = await checkout(api, ctx);
      try {
        const out = await gh.git(dir, ["grep", "-n", "-I", "-E", "-e", a.pattern, sha, "--", ...(a.path ? [a.path] : [])]);
        const lines = out.split("\n").filter(Boolean).map((l) => l.slice(sha.length + 1));
        return textResult(lines.slice(0, 300).join("\n") + (lines.length > 300 ? `\n(${lines.length - 300} more)` : ""));
      } catch (e) {
        // git grep exits 1 with no output when nothing matches; real errors print to stderr.
        if (/^git grep failed: Command failed/.test(message(e))) return textResult("No matches.");
        throw e;
      }
    },
  });

  const repoLs = defineTool({
    name: "repo_ls",
    description: "List a directory of the repository at the pull request head. Directories end with /.",
    parameters: Type.Object({ path: Type.Optional(Type.String({ description: "Directory; default: the root" })) }),
    replay: "safe",
    execute: async (a, api, ctx) => {
      const { dir, sha } = await checkout(api, ctx);
      const path = (a.path ?? "").replace(/^\.?\/?/, "").replace(/\/?$/, "/");
      const out = await gh.git(dir, ["ls-tree", sha, "--", path === "/" ? "." : path]);
      return textResult(
        out
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [meta, name] = l.split("\t");
            return meta.split(" ")[1] === "tree" ? `${name}/` : name;
          })
          .join("\n") || "Empty or missing directory",
      );
    },
  });

  // No replay policy: a crash mid-call returns an interrupted result instead of saving a second review.
  const saveReview = defineTool({
    name: "save_review",
    description: `Save your review on GitHub as a pending review: only ${me.name} sees it until they submit it in GitHub, where they also pick the final verdict. It never submits. Call it once per review. Inline comments must be on lines of the diff (side RIGHT is the new code, LEFT the removed code).`,
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal("approve"), Type.Literal("comment"), Type.Literal("request_changes")], {
        description: `Your suggestion; ${me.name} chooses the final one`,
      }),
      summary: Type.String({ description: "The review body on GitHub: 1 to 3 sentences." }),
      concerns: Type.Array(Type.String(), {
        maxItems: 3,
        description: "The main concerns, a few words each, for the short Slack note. Empty when there are none.",
      }),
      comments: Type.Array(
        Type.Object({
          path: Type.String(),
          line: Type.Number({ description: "Line number in the file, on the given side" }),
          side: Type.Optional(Type.Union([Type.Literal("RIGHT"), Type.Literal("LEFT")])),
          start_line: Type.Optional(Type.Number({ description: "First line of a multi-line comment" })),
          body: Type.String(),
        }),
      ),
    }),
    execute: async (a, api, ctx) => {
      const { pr, base, pull } = await context(api, ctx);
      login ||= ((await gh.api("GET", "user")) as { login: string }).login;
      const reviews = (await gh.api("GET", `${base}/pulls/${pr.number}/reviews?per_page=100`)) as {
        state: string;
        user?: { login: string };
        html_url?: string;
      }[];
      const pending = reviews.find((r) => r.state === "PENDING" && r.user?.login === login);
      const comments = a.comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: c.side ?? "RIGHT",
        ...(c.start_line && c.start_line < c.line ? { start_line: c.start_line, start_side: c.side ?? "RIGHT" } : {}),
        body: c.body,
      }));
      let status: "pending_on_github" | "not_saved" = "pending_on_github";
      let note: string | undefined;
      let reviewUrl: string | undefined;
      // Without an `event`, GitHub keeps the review PENDING: a draft only its author sees.
      const post = async (body: Record<string, unknown>) =>
        ((await gh.api("POST", `${base}/pulls/${pr.number}/reviews`, { body })) as { html_url?: string }).html_url;
      if (pending) {
        status = "not_saved";
        note = `${login} already has a pending review on this pull request (${pending.html_url ?? pr.url}); submit or discard it, then ask again`;
      } else {
        try {
          reviewUrl = await post({ commit_id: pull.head.sha, body: a.summary, comments });
        } catch (e) {
          if (!comments.length) {
            status = "not_saved";
            note = message(e);
          } else {
            // GitHub refuses the whole review when one comment is off the diff: keep them in the body instead.
            try {
              const listed = comments.map((c) => `- \`${c.path}:${c.line}\` ${c.body}`).join("\n");
              reviewUrl = await post({ commit_id: pull.head.sha, body: `${a.summary}\n\n${listed}` });
              note = `GitHub refused the inline comments (${message(e)}); they are listed in the review body instead`;
            } catch (e2) {
              status = "not_saved";
              note = message(e2);
            }
          }
        }
      }
      await api.commit(async (tx) => {
        const doc = await tx.doc(PrReview, api.conversationId);
        doc.reviewedSha = pull.head.sha;
        doc.reviews.push({
          at: Date.now(),
          sha: pull.head.sha,
          verdict: a.verdict,
          summary: a.summary,
          concerns: a.concerns,
          comments: a.comments,
          status,
          ...(reviewUrl ? { reviewUrl } : {}),
          ...(note ? { note } : {}),
        });
      }, ctx);
      return textResult(
        status === "pending_on_github"
          ? `Saved a pending review with ${a.comments.length} comment(s) on ${pr.url}${note ? `. Note: ${note}` : ""}. Only ${me.name} sees it until they submit it in GitHub.`
          : `Not saved on GitHub: ${note}. The review is kept in this conversation for ${me.name}.`,
      );
    },
  });

  return defineExtension({
    name: "pr-review",
    tools: [prRead, repoCheckout, repoRead, repoGrep, repoLs, saveReview, ...slackTools(slack, me)],
    sections: [
      section(
        "pr-review",
        () =>
          `You review GitHub pull requests for ${me.name}. You only read: save_review saves your comments as a pending GitHub review that only ${me.name} sees until they submit it, and draft_reply saves a Slack draft they send themselves. Never say you posted, approved or requested changes.
For each request:
1. pr_read overview. If you reviewed this pull request before (reviewedSha), review only what changed since: pr_read since_last_review, and say so.
2. pr_read files, diff, comments and checks. When the pull request is substantial (more than about 400 changed lines or 10 files, or it changes shared interfaces, concurrency, data handling or security), call repo_checkout and read the code around the change with repo_read, repo_grep and repo_ls: callers, tests and related code.
3. Look for problems that must be fixed: wrong logic, missed edge cases, error handling, security, concurrency, behavior under load, breaking changes, and risky code without tests. Skip style nits. Do not repeat points others already made.
4. Call save_review once. Each inline comment is on a diff line, specific, short and actionable, in ${me.name}'s voice. The summary has 1 to 3 sentences. No problems found: no comments, verdict approve.
5. Then call draft_reply once for the Slack thread that asked: the pull request link, your suggested verdict and at most 3 main concerns of a few words each. The details are in the GitHub comments, so keep it very short.
End with one line: what you saved.`,
        { tag: false },
      ),
    ],
  });
}

export type ReviewRequest = {
  pr: PrRef;
  thread: { channel: string; channelName: string; threadTs: string | null };
  requestId: string;
};

/** start_pr_review for the Slack thread agents: hands a pull request to its own review agent. */
export function prStartExtension(me: SlackMe, start: (request: ReviewRequest) => Promise<string>): Extension {
  const tool = defineTool({
    name: "start_pr_review",
    description:
      "Start a review of a GitHub pull request in its own review agent, which saves a pending GitHub review and drafts the Slack reply in this thread. Returns at once. A pull request that was reviewed before goes to the same agent, which reviews only the new commits.",
    parameters: Type.Object({ url: Type.String({ description: "The pull request URL, …/<owner>/<repo>/pull/<number>" }) }),
    replay: "safe",
    execute: async (a, api, ctx) => {
      const pr = parsePr(a.url);
      if (!pr) throw Error(`Not a pull request URL: ${a.url}`);
      const thread = await api.snapshot(SlackThread, api.conversationId, ctx);
      if (!thread?.channel) throw Error("This conversation has no Slack thread");
      const text = await start({
        pr,
        thread: { channel: thread.channel, channelName: thread.channelName, threadTs: thread.threadTs },
        requestId: `pr:${api.conversationId}:${api.taskId}:${pr.key}`,
      });
      return textResult(text);
    },
  });
  return defineExtension({
    name: "pr-start",
    tools: [tool],
    sections: [
      section(
        "pr-start",
        () =>
          `When a message asks ${me.name} to review a GitHub pull request (a …/pull/<number> link), call start_pr_review once for each pull request. Its review agent drafts the Slack reply when the review is done, so do not call draft_reply for a review request. Reply yourself only when the message also asks something else.`,
        { tag: false },
      ),
    ],
  });
}
