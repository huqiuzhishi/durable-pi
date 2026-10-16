<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import {
  Activity,
  ArrowUpRight,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownRight,
  FileCode2,
  FileDiff,
  FolderOpen,
  GitFork,
  MessageSquare,
  Pencil,
  PanelLeft,
  PanelTop,
  SquareTerminal,
} from "lucide-vue-next";
import type { AgentSummary } from "@sdk/api";
import { lineage } from "@sdk/models";
import TranscriptItem from "./TranscriptItem.vue";
import DeviceIcon from "./DeviceIcon.vue";
import Composer from "./Composer.vue";
import TerminalPanel from "./TerminalPanel.vue";
import {
  activeLineage,
  agent,
  agentHandle,
  agentState,
  changedFiles,
  device,
  notify,
  openFileInNvim,
  preset,
  scrollToToolCall,
  select,
  selected,
  sessionAgents,
  sessionSummary,
  toggle,
  layout,
  ui,
} from "../client/store";

const chat = ref<HTMLElement>();
const lineageNav = ref<HTMLElement>();
const picker = ref(false);
const filesMenu = ref(false);
const filesMenuLeft = ref(0);
// The hub reaches local devices directly and ssh/exe-dev devices over ssh; url devices have no shell access.
const canTerminal = computed(() => !!sessionSummary.value?.cwd && device.value?.kind !== "url");
// Terminal can sit above or left of chat. Each split size persists per browser.
const panel = ref<HTMLElement>();
const terminalLeft = ref(localStorage.getItem("dpi.terminal-position") === "left");
const savedSize = () =>
  Number(localStorage.getItem(terminalLeft.value ? "dpi.terminal-width" : "dpi.terminal-height")) || 50;
const termSize = ref(savedSize());
function toggleTerminalPosition() {
  terminalLeft.value = !terminalLeft.value;
  localStorage.setItem("dpi.terminal-position", terminalLeft.value ? "left" : "top");
  termSize.value = savedSize();
}
function resizeTerminal(e: PointerEvent) {
  const box = panel.value!.getBoundingClientRect();
  const move = (m: PointerEvent) =>
    (termSize.value = Math.max(
      15,
      Math.min(
        85,
        terminalLeft.value
          ? ((m.clientX - box.left) / box.width) * 100
          : ((m.clientY - box.top) / box.height) * 100,
      ),
    ));
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    localStorage.setItem(
      terminalLeft.value ? "dpi.terminal-width" : "dpi.terminal-height",
      String(Math.round(termSize.value)),
    );
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
const items = computed(() => agentState.value.items);
const liveItem = computed(() => items.value.some((i) => i.kind === "assistant" && i.streaming));
const runningTool = computed(() =>
  items.value.some(
    (i) =>
      (i.kind === "tool" && i.call.status === "running") ||
      (i.kind === "assistant" &&
        i.blocks.some((b) => b.type === "tool" && b.call.status === "running")),
  ),
);

const source = (a: AgentSummary) =>
  a.kind === "fork"
    ? `Forked from agent #${a.parentId} at entry #${a.forkedAt}`
    : a.kind === "subagent"
      ? `Owned by agent #${a.ownerAgentId}`
      : "Root agent";
const choices = computed(() =>
  sessionAgents.value
    .map((a) => ({ ...a, lineage: lineage(sessionAgents.value, a.id) }))
    .sort((a, b) => {
      for (let i = 0; i < Math.min(a.lineage.length, b.lineage.length); i++)
        if (a.lineage[i].id !== b.lineage[i].id) return a.lineage[i].id - b.lineage[i].id;
      return a.lineage.length - b.lineage.length;
    }),
);
const current = computed(() => activeLineage.value.at(-1));

const kindLabel = (a: AgentSummary) => (a.kind === "root" ? "agent" : a.kind);

/** Device crumb: show it in the network tree. Workspace crumb: open its root agent. */
function revealDevice() {
  if (!selected.value) return;
  layout.tree = true;
  toggle(selected.value.deviceId, true);
}
function openWorkspace() {
  const root = sessionAgents.value.find((a) => a.kind === "root") ?? sessionAgents.value[0];
  if (root) choose(root.id);
}

function choose(id: number) {
  picker.value = false;
  if (selected.value) select({ ...selected.value, agentId: id });
}

function fork(entryId: number) {
  const handle = agentHandle.value;
  const t = selected.value;
  if (!handle || !t) return;
  ui.dialog = {
    kind: "prompt",
    title: "Fork conversation",
    hint: `${current.value?.name ?? `Agent #${t.agentId}`} / entry #${entryId}. Leave the name blank to use Fork #ID.`,
    label: "Fork name",
    optional: true,
    placeholder: "e.g. Alternative approach",
    submit: "Create fork",
    run: async (name) => {
      const created = await handle.fork({ entryId, name: name || undefined });
      select({ ...t, agentId: created.id });
      notify(`Forked at entry #${entryId}. App State stays shared.`);
    },
  };
}

function renameAgent() {
  const handle = agentHandle.value;
  const a = current.value;
  if (!handle || !a) return;
  ui.dialog = {
    kind: "prompt",
    title: "Rename agent",
    label: "Agent name",
    value: a.named ? a.name : "",
    placeholder: a.name,
    submit: "Save name",
    run: (name) => handle.rename(name),
  };
}

watch(selected, () => {
  picker.value = false;
  filesMenu.value = false;
});

function toggleFilesMenu(event: MouseEvent) {
  const button = event.currentTarget as HTMLElement;
  const parent = button.closest<HTMLElement>(".lineage-picker");
  const width = Math.min(520, window.innerWidth - 32);
  filesMenuLeft.value = Math.max(0, Math.min(button.offsetLeft, (parent?.clientWidth ?? width) - width));
  filesMenu.value = !filesMenu.value;
  picker.value = false;
}

function copyFilePath(path: string) {
  void navigator.clipboard.writeText(path);
  notify(`Copied ${path}`);
}
function jumpToFile(callId: string) {
  filesMenu.value = false;
  scrollToToolCall(callId);
}
function openChangedFileInNvim(path: string) {
  filesMenu.value = false;
  openFileInNvim(path);
}

// Follow the bottom of the transcript unless the reader scrolled up.
let pinned = true;
watch(
  agent.version,
  () => {
    const el = chat.value;
    pinned = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  },
  { flush: "pre" },
);
watch(agent.version, () => {
  if (pinned)
    void nextTick(() =>
      chat.value?.scrollTo({ top: chat.value.scrollHeight, behavior: "instant" }),
    );
});
watch(
  () => activeLineage.value.length,
  () =>
    void nextTick(
      () => lineageNav.value && (lineageNav.value.scrollLeft = lineageNav.value.scrollWidth),
    ),
);
</script>

<template>
  <section ref="panel" class="chat-panel">
    <header class="chat-header">
      <div class="lineage-picker">
        <div class="lineage-toolbar">
          <nav
            ref="lineageNav"
            class="crumbs conversation-lineage"
            aria-label="Conversation lineage"
          >
            <button class="crumb" :title="`${device?.name} · ${device?.url}`" @click="revealDevice">
              <span class="crumb-kind">device</span>
              <span class="crumb-main"
                ><DeviceIcon :device="device" :size="18" /><span class="device-chip">{{
                  device?.id
                }}</span></span
              >
            </button>
            <ChevronRight class="crumb-sep" :size="18" aria-hidden="true" />
            <button class="crumb" :title="sessionSummary?.cwd" @click="openWorkspace">
              <span class="crumb-kind">workspace</span>
              <span class="crumb-main"
                ><FolderOpen :size="18" aria-hidden="true" /><span class="crumb-name">{{
                  sessionSummary?.name
                }}</span></span
              >
            </button>
            <template v-for="c in activeLineage" :key="c.id">
              <ChevronRight class="crumb-sep" :size="18" aria-hidden="true" />
              <button
                class="crumb"
                :class="{ current: c.id === selected?.agentId }"
                :aria-current="c.id === selected?.agentId ? 'page' : undefined"
                :title="source(c)"
                @click="choose(c.id)"
              >
                <span class="crumb-kind">{{ kindLabel(c) }}</span>
                <span class="crumb-main"
                  ><GitFork
                    v-if="c.kind === 'fork'"
                    :size="18"
                    aria-hidden="true"
                  /><CornerDownRight
                    v-else-if="c.kind === 'subagent'"
                    :size="18"
                    aria-hidden="true"
                  /><MessageSquare v-else :size="18" aria-hidden="true" /><span
                    class="crumb-name"
                    >{{ c.name }}</span
                  ></span
                >
              </button>
            </template>
          </nav>
          <button
            class="icon-button changed-files-toggle"
            :class="{ active: filesMenu }"
            aria-label="Changed files"
            aria-haspopup="dialog"
            :aria-expanded="filesMenu"
            :title="`${changedFiles.length} file(s) changed by this agent`"
            @click="toggleFilesMenu"
          >
            <FileDiff :size="16" /><span v-if="changedFiles.length" class="changed-files-badge">{{
              changedFiles.length
            }}</span>
          </button>
          <button
            v-if="canTerminal"
            class="icon-button"
            :class="{ active: ui.terminal }"
            aria-label="Toggle terminal"
            :aria-pressed="ui.terminal"
            :title="`Terminal in ${sessionSummary?.cwd} on ${device?.id} (tmux)`"
            @click="ui.terminal = !ui.terminal"
          >
            <SquareTerminal :size="18" />
          </button>
          <button
            v-if="ui.terminal && canTerminal"
            class="icon-button"
            :aria-label="terminalLeft ? 'Move terminal above chat' : 'Move terminal left of chat'"
            :title="terminalLeft ? 'Terminal above chat' : 'Terminal left of chat'"
            @click="toggleTerminalPosition"
          >
            <PanelTop v-if="terminalLeft" :size="18" />
            <PanelLeft v-else :size="18" />
          </button>
          <button
            class="icon-button"
            aria-label="Rename agent"
            title="Rename this agent"
            :disabled="!current"
            @click="renameAgent"
          >
            <Pencil :size="18" />
          </button>
          <button
            class="icon-button conversation-menu-toggle"
            aria-label="Browse conversations"
            aria-haspopup="dialog"
            :aria-expanded="picker"
            aria-controls="conversation-picker"
            title="Browse roots and forks"
            @click="picker = !picker"
          >
            <ChevronDown :size="18" />
          </button>
        </div>
        <div v-if="current && current.kind !== 'root'" class="lineage-source">
          {{ source(current) }}
        </div>
        <template v-if="filesMenu">
          <button
            class="conversation-menu-dismiss"
            aria-label="Close changed files"
            @click="filesMenu = false"
          />
          <section
            class="conversation-picker changed-files-popover"
            :style="{ left: `${filesMenuLeft}px` }"
            role="dialog"
            aria-label="Changed files"
          >
            <div class="conversation-picker-heading">
              <span>Changed files ({{ changedFiles.length }})</span>
              <span v-if="sessionSummary?.cwd" class="changed-files-cwd">{{
                sessionSummary.cwd
              }}</span>
            </div>
            <div v-if="!changedFiles.length" class="changed-files-empty">
              No files written or edited by this agent yet.
            </div>
            <div v-for="f in changedFiles" :key="f.path" class="changed-file-row">
              <button
                type="button"
                class="changed-file-main"
                :title="`Jump to ${f.tool} (#${f.entryId}) — ${f.path}`"
                @click="jumpToFile(f.callId)"
              >
                <FileCode2 :size="15" class="changed-file-icon" />
                <div class="changed-file-text">
                  <span class="changed-file-name">{{ f.name }}</span>
                  <span class="changed-file-path">{{ f.rel }}</span>
                </div>
                <span class="changed-file-meta">
                  <span class="changed-file-tool" :class="f.tool">{{ f.tool }}</span>
                  <span v-if="f.count > 1" class="changed-file-count">×{{ f.count }}</span>
                  <span class="changed-file-entry">#{{ f.entryId }}</span>
                </span>
              </button>
              <div class="changed-file-actions">
                <button
                  type="button"
                  class="icon-button"
                  :title="`Copy ${f.path}`"
                  :aria-label="`Copy path ${f.name}`"
                  @click="copyFilePath(f.path)"
                >
                  <Copy :size="14" />
                </button>
                <button
                  v-if="canTerminal"
                  type="button"
                  class="changed-file-nvim"
                  :title="`Open ${f.path} with nvim in terminal`"
                  :aria-label="`Open ${f.name} in nvim`"
                  @click="openChangedFileInNvim(f.path)"
                >
                  <SquareTerminal :size="13" />nvim
                </button>
              </div>
            </div>
          </section>
        </template>
        <template v-if="picker">
          <button
            class="conversation-menu-dismiss"
            aria-label="Close conversation picker"
            @click="picker = false"
          />
          <section
            id="conversation-picker"
            class="conversation-picker"
            role="dialog"
            aria-label="Choose conversation"
          >
            <div class="conversation-picker-heading">Roots &amp; forks</div>
            <button
              v-for="c in choices"
              :key="c.id"
              class="conversation-choice"
              :class="{ selected: c.id === selected?.agentId }"
              :aria-label="c.lineage.map((x) => x.name).join(' → ')"
              :aria-current="c.id === selected?.agentId ? 'page' : undefined"
              @click="choose(c.id)"
            >
              <div class="conversation-choice-content">
                <span class="choice-lineage">
                  <template v-for="(ancestor, index) in c.lineage" :key="ancestor.id">
                    <ChevronRight v-if="index" :size="18" aria-hidden="true" />
                    <span :class="{ 'choice-ancestor': index < c.lineage.length - 1 }">{{
                      ancestor.name
                    }}</span>
                  </template>
                </span>
                <span class="choice-source">{{ source(c) }}</span>
              </div>
              <Check v-if="c.id === selected?.agentId" :size="18" aria-hidden="true" />
              <GitFork v-else-if="c.kind === 'fork'" :size="18" aria-hidden="true" />
              <MessageSquare v-else :size="18" aria-hidden="true" />
            </button>
          </section>
        </template>
      </div>
    </header>
    <div class="chat-body" :class="{ 'terminal-left': terminalLeft }">
      <template v-if="ui.terminal && canTerminal && selected">
        <TerminalPanel
          :key="`${selected.deviceId}/${selected.sessionId}`"
          :style="{ flexBasis: `${termSize}%` }"
          :device-id="selected.deviceId"
          :session-id="selected.sessionId"
          :cwd="sessionSummary!.cwd"
        />
        <div
          class="terminal-resizer"
          role="separator"
          :aria-orientation="terminalLeft ? 'vertical' : 'horizontal'"
          aria-label="Resize terminal"
          @pointerdown.prevent="resizeTerminal"
        />
      </template>
      <div class="chat-column">
        <div ref="chat" class="chat-scroll" data-testid="chat">
      <div v-if="!agentState.ready" class="chat-empty">
        <Activity :size="30" />
        <h2 v-if="agent.status.value === 'fault'">This agent is unavailable.</h2>
        <h2 v-else>Connecting to the agent…</h2>
        <p v-if="agent.fault.value" class="message-error">{{ agent.fault.value }}</p>
        <p v-else>The agent keeps working on {{ device?.id }} while this view connects.</p>
      </div>
      <template v-else>
        <div v-if="!items.length" class="chat-empty">
          <div class="agent-orb"><img src="/icons/durable-pi.svg" alt="Durable Pi" /><i /></div>
          <span class="eyebrow">YOUR DURABLE AGENT IS READY</span>
          <h2>A conversation with continuity.</h2>
          <p>Messages, tools and state live on {{ device?.id }}, beyond this window.</p>
          <div class="starter-grid">
            <button
              @click="
                preset(
                  'Inspect this directory using your tools and give me a brief overview. Do not modify any files.',
                )
              "
            >
              <FolderOpen :size="18" /><strong>Explore this directory</strong
              ><span>See coding tools in action</span><ArrowUpRight :size="18" /></button
            ><button
              @click="
                preset(
                  'Use read_state, then update_state to add a field called progress with value 1 and a boolean called ready with value false.',
                )
              "
            >
              <Braces :size="18" /><strong>Make a state change</strong
              ><span>Watch the workspace update</span><ArrowUpRight :size="18" />
            </button>
          </div>
        </div>
        <TranscriptItem v-for="item in items" :key="item.id" :item="item" @fork="fork" />
        <div v-if="agentState.running && !liveItem && !runningTool" class="entry live-generation">
          <div class="message-label">
            AGENT
            <span class="streaming">{{ agentState.retry ? "Retry scheduled" : "Working" }}</span>
          </div>
          <div class="typing"><i /><i /><i /></div>
        </div>
        <p v-if="agentState.retry" class="hint retry-note">
          Retrying: {{ agentState.retry.error }}
        </p>
        <p v-for="(n, i) in agentState.notices" :key="i" class="message-error">{{ n }}</p>
      </template>
        </div>
        <Composer />
      </div>
    </div>
  </section>
</template>
