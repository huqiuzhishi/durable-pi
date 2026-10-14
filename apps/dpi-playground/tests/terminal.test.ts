import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { NetDevice } from "../../dpi-sdk/src/node/config.js";
import { terminalCommand, tmuxScript } from "../apps/dpi-playground-hub/src/terminal.js";

const device = (d: Partial<NetDevice>) => ({ id: "d", kind: "local", ...d }) as NetDevice;

test("terminal: tmux per session in its folder, local shell or ssh -t, none for url devices", () => {
  const script = tmuxScript("s/1", "/tmp/it's here");
  assert.match(script, /tmux new-session -A -s dpi-s_1 -c '\/tmp\/it'\\''s here' "\$Z -l"$/);
  // The quoted folder survives a real shell parse.
  assert.equal(execFileSync("sh", ["-c", `set -- ${script.split(" -c ")[1].split(' "$Z')[0]}; printf %s "$1"`]).toString(), "/tmp/it's here");

  const local = terminalCommand(device({}), "s1", "/w");
  assert.ok("file" in local && local.args[0] === "-lc" && local.args[1].includes("dpi-s1"));
  const ssh = terminalCommand(device({ kind: "ssh", ssh: "box" }), "s1", "/w");
  assert.ok("file" in ssh && ssh.file === "ssh");
  assert.deepEqual(ssh.args.slice(-3, -1), ["-t", "box"]);
  assert.match((terminalCommand(device({ kind: "url", id: "u" }), "s1", "/w") as { error: string }).error, /no ssh/);
  assert.match((terminalCommand(undefined, "s1", "/w") as { error: string }).error, /not in dpi-network/);
});
