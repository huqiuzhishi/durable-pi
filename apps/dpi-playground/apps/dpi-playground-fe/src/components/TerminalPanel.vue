<script setup lang="ts">
// The session's tmux terminal on its device (see the hub's terminal.ts). Closing the panel or the tab only
// detaches; reopening reattaches to the same shell, nvim and all.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import "@xterm/xterm/css/xterm.css";
import { theme } from "../client/store";

const props = defineProps<{ deviceId: string; sessionId: string; cwd: string }>();
const host = ref<HTMLElement>();
let ws: WebSocket | undefined;
let term: Terminal | undefined;
let observer: ResizeObserver | undefined;

function termTheme() {
  const s = getComputedStyle(document.documentElement);
  const v = (k: string, fallback: string) => s.getPropertyValue(k).trim() || fallback;
  return {
    background: v("--surface", "#241819"),
    foreground: v("--text", "#f2eeee"),
    cursor: v("--accent", "#ff8997"),
  };
}

watch(theme, () => {
  if (term) term.options.theme = termTheme();
});

onMounted(() => {
  term = new Terminal({
    fontFamily: '"JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "IBM Plex Mono", monospace',
    fontSize: 14,
    cursorBlink: true,
    scrollback: 5000,
    theme: termTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // tmux emits OSC 52 with the default (empty) selector; xterm's browser provider accepts only `c`.
  term.loadAddon(
    new ClipboardAddon(undefined, {
      readText: () => navigator.clipboard.readText(),
      writeText: (_selection, text) => navigator.clipboard.writeText(text),
    }),
  );
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
