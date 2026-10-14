<script setup lang="ts">
// The session's tmux terminal on its device (see the hub's terminal.ts). Closing the panel or the tab only
// detaches; reopening reattaches to the same shell, nvim and all.
import { onBeforeUnmount, onMounted, ref } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const props = defineProps<{ deviceId: string; sessionId: string; cwd: string }>();
const host = ref<HTMLElement>();
let ws: WebSocket | undefined;
let term: Terminal | undefined;
let observer: ResizeObserver | undefined;

onMounted(() => {
  term = new Terminal({
    fontFamily: '"JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "IBM Plex Mono", monospace',
    fontSize: 14,
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: "#1e1718", foreground: "#f3e7e1", cursor: "#ff8997" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host.value!);
  fit.fit();
  const q = new URLSearchParams({
    device: props.deviceId,
    session: props.sessionId,
    cwd: props.cwd,
    cols: String(term.cols),
    rows: String(term.rows),
  });
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminal?${q}`);
  ws.onmessage = (e) => term?.write(e.data as string);
  ws.onclose = (e) => term?.write(`\r\n\x1b[2m[terminal closed${e.reason ? `: ${e.reason}` : ""}]\x1b[0m\r\n`);
  term.onData((data) => ws?.readyState === WebSocket.OPEN && ws.send(data));
  // Binary frames are control messages; text frames are keystrokes.
  term.onResize(({ cols, rows }) => {
    if (ws?.readyState === WebSocket.OPEN)
      ws.send(new TextEncoder().encode(JSON.stringify({ resize: [cols, rows] })));
  });
  observer = new ResizeObserver(() => fit.fit());
  observer.observe(host.value!);
  term.focus();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  ws?.close();
  term?.dispose();
});
</script>

<template>
  <!-- Keys stay in the terminal: Escape, Ctrl-N and Ctrl-T belong to the shell and nvim, not the hub. -->
  <div ref="host" class="terminal-panel" data-testid="terminal" @keydown.stop />
</template>
