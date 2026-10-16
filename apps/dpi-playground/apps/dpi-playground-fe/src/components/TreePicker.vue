<script setup lang="ts">
import { computed } from "vue";
import { Activity, Check, CornerDownRight, GitFork, MessageSquare, X } from "lucide-vue-next";
import type { AgentSummary } from "@sdk/api";
import { select, selected, sessionAgents, sessionSummary } from "../client/store";

const emit = defineEmits<{ close: [] }>();
type Row = { agent: AgentSummary; depth: number };
const rows = computed<Row[]>(() => {
  const agents = sessionAgents.value;
  const children = new Map<number | undefined, AgentSummary[]>();
  for (const agent of agents) {
    const parent = agent.parentId ?? agent.ownerAgentId;
    children.set(parent, [...(children.get(parent) ?? []), agent]);
  }
  const out: Row[] = [];
  const seen = new Set<number>();
  const visit = (agent: AgentSummary, depth: number) => {
    if (seen.has(agent.id)) return;
    seen.add(agent.id);
    out.push({ agent, depth });
    for (const child of children.get(agent.id) ?? []) visit(child, depth + 1);
  };
  for (const root of children.get(undefined) ?? []) visit(root, 0);
  for (const agent of agents) visit(agent, 0);
  return out;
});

function source(agent: AgentSummary) {
  if (agent.kind === "fork") return `Forked at entry #${agent.forkedAt}`;
  if (agent.kind === "subagent") return `Owned by agent #${agent.ownerAgentId}`;
  return "Root agent";
}
function choose(agent: AgentSummary) {
  if (!selected.value) return;
  select({ ...selected.value, agentId: agent.id });
  emit("close");
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="modal tree-modal" role="dialog" aria-modal="true" aria-labelledby="tree-title">
      <header>
        <div><span class="eyebrow">{{ sessionSummary?.name }}</span><h2 id="tree-title">Agent tree</h2></div>
        <button class="icon-button" aria-label="Close agent tree" @click="emit('close')"><X :size="18" /></button>
      </header>
      <div class="agent-tree-list" role="tree">
        <button
          v-for="row in rows"
          :key="row.agent.id"
          role="treeitem"
          :aria-level="row.depth + 1"
          :aria-current="row.agent.id === selected?.agentId ? 'true' : undefined"
          :class="{ selected: row.agent.id === selected?.agentId }"
          :style="{ '--depth': row.depth }"
          @click="choose(row.agent)"
        >
          <GitFork v-if="row.agent.kind === 'fork'" :size="15" />
          <CornerDownRight v-else-if="row.agent.kind === 'subagent'" :size="15" />
          <MessageSquare v-else :size="15" />
          <div><strong>{{ row.agent.name }}</strong><small>{{ source(row.agent) }}</small></div>
          <Activity v-if="row.agent.busy" :size="15" class="spin" />
          <Check v-else-if="row.agent.id === selected?.agentId" :size="16" />
        </button>
      </div>
    </section>
  </div>
</template>
