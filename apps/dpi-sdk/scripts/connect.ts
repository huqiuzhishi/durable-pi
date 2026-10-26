// `just connect [device...] [--deploy]`: from this machine to the web UI in one command. With no ids and several
// remote devices it opens fzf (Tab selects more than one). For each device it opens an ssh tunnel when the url is a
// local port, syncs the device and restarts it only when something changed (--deploy runs the full `up` instead).
// Tunnels reconnect after network loss or laptop sleep. Then it starts this machine's backend and the hub, and opens
// the browser. Ctrl-C stops what it started; the devices' own services keep running.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { connect as tcp } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DpiClient } from "../src/client.js";
import { loadNetworkConfig, syncConfigToRegistry, type NetDevice } from "../src/node/config.js";
import { drivers, serviceInstalled, syncCode, waitOnline, type DriverContext } from "../src/node/drivers.js";
import { run, SSH_OPTS, sleep } from "../src/node/ops.js";
import { NetworkRegistry } from "../src/node/registry.js";

const argv = process.argv.slice(2);
const force = argv.includes("--deploy");
const ids = argv.filter((a) => !a.startsWith("--"));
const log = (line: string) => console.log(line);
const fail = (message: string): never => {
  console.error(`connect: ${message}`);
  process.exit(1);
};
const config = loadNetworkConfig();
const registry = new NetworkRegistry();
syncConfigToRegistry(config, registry);
const ctx: DriverContext = { config, registry, args: [], log };
const hubPort = Number(process.env.DPI_HUB_PORT ?? 4781);

const started: ChildProcess[] = [];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  const alive = started.filter((p) => p.exitCode === null);
  for (const p of alive) {
    try {
      process.kill(-p.pid!, "SIGTERM");
    } catch {}
  }
  Promise.race([Promise.all(alive.map((p) => new Promise((r) => p.once("exit", r)))), sleep(5000)]).then(() => process.exit(code));
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

/** Its own process group, so stop() also ends npm's and tsx's children. */
function start(
  name: string,
  cmd: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; fatal?: boolean } = {},
) {
  const proc = spawn(cmd, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [proc.stdout!, proc.stderr!]) createInterface({ input: stream }).on("line", (l) => log(`[${name}] ${l}`));
  proc.on("exit", (code) => {
    if (stopping) return;
    if (options.fatal === false) return void log(`${name} exited (code ${code}); skipped`);
    log(`${name} exited (code ${code}); stopping the rest. Run just connect again.`);
    stop(1);
  });
  started.push(proc);
  return proc;
}

const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = tcp(port, "127.0.0.1")
      .once("connect", () => {
        s.destroy();
        resolve(true);
      })
      .once("error", () => resolve(false));
  });

async function waitPort(port: number, what: string, timeoutMs = 60_000) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(500)) if (await listening(port)) return;
  throw Error(`${what} did not listen on 127.0.0.1:${port}`);
}

async function online(device: NetDevice) {
  const token = registry.get(device.id)?.token;
  if (!token) return false;
  return new DpiClient(device.url, token).device({ timeoutMs: 5000 }).then(
    () => true,
    () => false,
  );
}

async function bringUp(device: NetDevice) {
  const url = new URL(device.url);
  if (device.ssh && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) {
    const port = Number(url.port);
    if (await listening(port)) log(`tunnel ${device.id}: reusing 127.0.0.1:${port}`);
    else {
      const tunnel = start(
        `tunnel ${device.id}`,
        "sh",
        [
          "-c",
          'while true; do ssh "$@"; status=$?; echo "ssh exited (code $status); retrying in 2s" >&2; sleep 2; done',
          "dpi-tunnel",
          ...SSH_OPTS,
          "-N",
          "-o",
          "ExitOnForwardFailure=yes",
          "-L",
          `${port}:127.0.0.1:${device.port}`,
          device.ssh,
        ],
        { fatal: false },
      );
      await Promise.race([
        waitPort(port, `the ssh tunnel to ${device.ssh}`),
        new Promise<never>((_, reject) =>
          tunnel.once("exit", (code) => reject(Error(`ssh tunnel exited with code ${code}`))),
        ),
      ]);
      log(`tunnel ${device.id}: 127.0.0.1:${port} → ${device.ssh}:${device.port}`);
    }
  }
  const driver = drivers[device.kind];
  if (device.kind === "url") return void (await waitOnline(device, ctx));
  if (force || !(await serviceInstalled(device))) return void (await driver.up!(device, ctx));
  if (!registry.get(device.id)?.token) await driver.register!(device, ctx);
  const changed = await syncCode(device, ctx);
  if (changed || !(await online(device))) await driver.restart!(device, ctx);
  await waitOnline(device, ctx);
}

async function startLocal(local: NetDevice) {
  const port = Number(new URL(local.url).port);
  if (await listening(port)) return log(`backend ${local.id}: reusing ${local.url}`);
  if (!registry.get(local.id)?.token) await drivers.local.up!(local, ctx);
  start("backend", "npm", ["start", "--silent"], { cwd: join(config.root, "apps/dpi-backend") });
  await waitOnline(local, ctx);
}

async function startHub() {
  if (await listening(hubPort)) return log(`hub: reusing http://localhost:${hubPort}`);
  const app = join(config.root, "apps/dpi-playground");
  if (!existsSync(join(app, "apps/dpi-playground-fe/dist/index.html"))) {
    log("hub: building the web UI");
    await run("npm", ["run", "build", "--silent"], { cwd: app, echo: true });
  }
  start("hub", "npm", ["start", "--silent"], {
    cwd: app,
    env: { ...process.env, DPI_HUB_PORT: String(hubPort) },
  });
  await waitPort(hubPort, "the hub");
}

function pick(remote: NetDevice[]): NetDevice[] {
  if (remote.length <= 1) return remote;
  const usage = `pass device ids: ${remote.map((d) => d.id).join(", ")}`;
  if (!process.stdin.isTTY) fail(usage);
  const out = spawnSync(
    "fzf",
    ["--multi", "--no-preview", "--height=40%", "--reverse", "--delimiter=\t", "--prompt=connect> ", "--header=Tab selects, Enter connects"],
    { input: remote.map((d) => `${d.id}\t${d.kind}\t${d.ssh ?? d.url}`).join("\n"), encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] },
  );
  if (out.error) fail(`${usage} (or install fzf to pick)`);
  const chosen = out.stdout.split("\n").filter(Boolean).map((line) => line.split("\t")[0]);
  if (!chosen.length) fail("no device selected");
  return remote.filter((d) => chosen.includes(d.id));
}

async function main() {
  const devices = Object.values(config.devices);
  const chosen = ids.length
    ? ids.map((id) => config.devices[id] ?? fail(`No device "${id}" in ${config.file}. Devices: ${devices.map((d) => d.id).join(", ")}`))
    : pick(devices.filter((d) => d.kind !== "local"));
  const remote = chosen.filter((d) => d.kind !== "local");
  const results = await Promise.allSettled(remote.map(bringUp));
  results.forEach((r, i) => r.status === "rejected" && log(`${remote[i].id}: ${r.reason instanceof Error ? r.reason.message : r.reason}; skipped`));
  if (remote.length && results.every((r) => r.status === "rejected")) throw Error("no device came up");
  const local = devices.find((d) => d.kind === "local");
  if (local) await startLocal(local);
  await startHub();
  await run("open", [`http://localhost:${hubPort}`], { allowFail: true });
  log(`ready: http://localhost:${hubPort}${started.length ? "  (Ctrl-C stops the tunnel, backend and hub started here)" : ""}`);
}

main().catch((e) => {
  console.error(`connect: ${e instanceof Error ? e.message : String(e)}`);
  stop(1);
});
