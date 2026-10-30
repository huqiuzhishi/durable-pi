// dpi-backend: one device of the Durable Agent Network.
import express from "express";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { bearerAuth } from "./auth.js";
import { errorMiddleware } from "./errors.js";
import { v1 } from "./routes.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { gatewayClient, gatewaySlack, oncallExtension, pagerdutyOnCall, slackExtension, SlackWatcher, type SlackMe } from "./slack.js";
import { ghCli, prReviewExtension, prStartExtension } from "./pr-review.js";

delete process.env.TMUX;
delete process.env.TMUX_PANE;

const config = loadConfig();
// DPI_SLACK=1 turns on the personal Slack agent: drafts replies to your DMs and mentions, never sends.
const slack = process.env.DPI_SLACK === "1" ? gatewaySlack() : undefined;
const me: SlackMe = { id: "", name: "" };
const slackExt = slack && slackExtension(slack, me);
// DPI_ONCALL_CHANNEL and DPI_ONCALL_PD_POLICY add the on-call channel while PagerDuty shows you on call in that policy.
const oncallChannel = slack ? process.env.DPI_ONCALL_CHANNEL : undefined;
const oncallExt = oncallChannel && oncallExtension(gatewayClient, me, oncallChannel);
const oncall = oncallExt
  ? {
      channel: oncallChannel!,
      extension: oncallExt,
      active: pagerdutyOnCall(
        process.env.DPI_ONCALL_PD_CLI ?? join(homedir(), ".local/share/dpi/pd_cli.py"),
        process.env.DPI_ONCALL_PD_POLICY ?? "",
        () => me.name,
      ),
    }
  : undefined;
if (oncall && !process.env.DPI_ONCALL_PD_POLICY) throw Error("DPI_ONCALL_CHANNEL needs DPI_ONCALL_PD_POLICY");
// DPI_PR_REVIEW=1: a review request in Slack gets its own review agent, which saves a pending GitHub review.
let watcher: SlackWatcher | undefined;
const prReviewExt =
  slack && process.env.DPI_PR_REVIEW === "1"
    ? prReviewExtension(ghCli(), slack, me, process.env.DPI_PR_CLONE_ROOT ?? join(homedir(), "git"))
    : undefined;
const prStartExt = prReviewExt && prStartExtension(me, (r) => watcher!.startReview(r));
const extensions = [slackExt, oncallExt, prReviewExt, prStartExt].filter((e) => !!e);
const store = await Store.open({
  dataDir: config.dataDir,
  startDirs: config.startDirs,
  name: config.name,
  provider: config.provider,
  ...(extensions.length ? { extensions } : {}),
});
watcher =
  slack &&
  slackExt &&
  new SlackWatcher(store, slack, slackExt, me, {
    pollMs: Number(process.env.DPI_SLACK_POLL_SECONDS ?? 60) * 1000,
    ignore: new Set((process.env.DPI_SLACK_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
    ...(oncall ? { oncall } : {}),
    ...(prReviewExt && prStartExt ? { review: { extension: prReviewExt, start: prStartExt } } : {}),
  });
watcher?.start();

const app = express();
app.disable("x-powered-by");
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.use("/v1", bearerAuth(config.token), express.json({ limit: "256kb" }), v1(store));
app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "Route not found" } }));
app.use(errorMiddleware);

const server = createServer(app);
server.keepAliveTimeout = 65_000;
server.listen(config.port, config.host, () => {
  console.log(`dpi-backend "${config.name}" (uid ${store.uid}) on http://${config.host}:${config.port}`);
  console.log(`data: ${config.dataDir}  start dirs: ${config.startDirs.join(", ")}  provider: ${config.provider}`);
  if (config.host === "0.0.0.0")
    for (const addresses of Object.values(networkInterfaces()))
      for (const a of addresses ?? [])
        if (a.family === "IPv4" && !a.internal) console.log(`LAN: http://${a.address}:${config.port}`);
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  watcher?.stop();
  server.close();
  server.closeAllConnections();
  await store.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
