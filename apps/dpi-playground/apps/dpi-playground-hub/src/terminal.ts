// A real terminal per session, in the browser: /api/terminal is a WebSocket bridged to a pty that runs
// `tmux new-session -A` in the session's folder, so the shell outlives the tab and the hub. Local devices get
// this machine's login shell and dotfiles; ssh devices get `ssh -t` to the box and its own zsh and dotfiles.
import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { dirname, join } from "node:path";
import * as pty from "node-pty";
import { WebSocketServer } from "ws";
import type { NetDevice, NetworkConfig } from "../../../../dpi-sdk/src/node/config.js";
import { q, SSH_OPTS } from "../../../../dpi-sdk/src/node/ops.js";

// npm installs node-pty's prebuilt spawn-helper without its execute bit ("posix_spawnp failed").
const helper = join(
  dirname(createRequire(import.meta.url).resolve("node-pty/package.json")),
  "prebuilds",
  `${process.platform}-${process.arch}`,
  "spawn-helper",
);
try {
  const { mode } = statSync(helper);
  if (!(mode & 0o111)) chmodSync(helper, mode | 0o755);
} catch {}

/** The shell command that attaches to (or creates) the session's tmux session, preferring zsh. */
export function tmuxScript(sessionId: string, cwd: string) {
  const name = `dpi-${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  return `Z=$(command -v zsh || echo "$SHELL"); exec tmux new-session -A -s ${name} -c ${q(cwd)} "$Z -l"`;
}

/** What to run for a device, or why it has no terminal. */
export function terminalCommand(device: NetDevice | undefined, sessionId: string, cwd: string) {
  if (!device) return { error: "This device is not in dpi-network.yaml" };
  const script = tmuxScript(sessionId, cwd);
  if (device.kind === "local") return { file: process.env.SHELL || "/bin/zsh", args: ["-lc", script] };
  if (device.ssh) return { file: "ssh", args: [...SSH_OPTS, "-t", device.ssh, script] };
  return { error: `${device.id} is a ${device.kind} device with no ssh access` };
}

/**
 * Accepts upgrades only from the hub's own page (a Host it serves and a matching Origin), and only while the
 * hub listens on loopback: a terminal is a shell on this machine and on every ssh box it can reach.
 */
export function terminalUpgrade(
  allowedHosts: Set<string>,
  loopback: boolean,
  config: () => NetworkConfig | undefined,
) {
  const wss = new WebSocketServer({ noServer: true });
  return (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://hub");
    if (url.pathname !== "/api/terminal") return false;
    const host = (req.headers.host ?? "").toLowerCase();
    let origin = "";
    try {
      origin = new URL(req.headers.origin ?? "").host.toLowerCase();
    } catch {}
    const refuse = (status: string) => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      return true;
    };
    if (!loopback || !allowedHosts.has(host) || origin !== host) return refuse("403 Forbidden");
    const [deviceId, sessionId, cwd] = ["device", "session", "cwd"].map(
      (k) => url.searchParams.get(k) ?? "",
    );
    if (!deviceId || !sessionId || !cwd) return refuse("400 Bad Request");
    const cmd = terminalCommand(config()?.devices[deviceId], sessionId, cwd);
    const size = (k: string, d: number) =>
      Math.max(2, Math.min(500, Number(url.searchParams.get(k)) || d));
    wss.handleUpgrade(req, socket, head, (ws) => {
      if ("error" in cmd) return ws.close(4000, cmd.error);
      const term = pty.spawn(cmd.file, cmd.args, {
        name: "xterm-256color",
        cols: size("cols", 100),
        rows: size("rows", 30),
        cwd: process.env.HOME,
        // A hub started from inside tmux must not make the local tmux think it is nested.
        env: Object.fromEntries(
          Object.entries({ ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" }).filter(
            ([k, v]) => v !== undefined && k !== "TMUX" && k !== "TMUX_PANE",
          ),
        ) as Record<string, string>,
      });
      term.onData((data) => ws.send(data));
      term.onExit(() => ws.close());
      // Text frames are keystrokes; a binary frame carries {"resize":[cols,rows]}.
      ws.on("message", (data, binary) => {
        if (!binary) return term.write(data.toString());
        const [cols, rows] = (JSON.parse(data.toString()) as { resize: [number, number] }).resize;
        if (cols > 1 && rows > 1) term.resize(Math.min(cols, 500), Math.min(rows, 300));
      });
      // Closing the tab only detaches this tmux client; the tmux session keeps running.
      ws.on("close", () => term.kill());
    });
    return true;
  };
}
