<script setup lang="ts">
import { computed, ref } from "vue";
import { Activity, Check, GitFork, MessageSquare, X } from "lucide-vue-next";
import DeviceIcon from "./DeviceIcon.vue";
import { network, select, selected } from "../client/store";

const emit = defineEmits<{ close: [] }>();
const search = ref("");
const rows = computed(() => {
  const query = search.value.trim().toLowerCase();
  return network.devices.value
    .flatMap((device) =>
      (device.tree?.sessions ?? []).flatMap((session) =>
        session.agents.map((agent) => ({ device, session, agent })),
      ),
    )
    .filter(({ device, session, agent }) =>
      `${device.id} ${device.name} ${session.name} ${session.cwd} ${agent.name}`
        .toLowerCase()
        .includes(query),
    )
    .sort((a, b) => b.session.createdAt - a.session.createdAt || a.agent.id - b.agent.id);
});

function choose(row: (typeof rows.value)[number]) {
  if (row.device.status !== "online") return;
  select({ deviceId: row.device.id, sessionId: row.session.id, agentId: row.agent.id });
  emit("close");
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="modal resume-modal" role="dialog" aria-modal="true" aria-labelledby="resume-title">
      <header>
        <div><span class="eyebrow">DURABLE SESSIONS</span><h2 id="resume-title">Resume an agent</h2></div>
        <button class="icon-button" aria-label="Close resume picker" @click="emit('close')"><X :size="18" /></button>
      </header>
      <input v-model="search" autofocus placeholder="Search device, session, agent or path…" aria-label="Search sessions" />
      <div class="resume-list">
        <button
          v-for="row in rows"
          :key="`${row.device.id}/${row.session.id}/${row.agent.id}`"
          :disabled="row.device.status !== 'online'"
          :class="{ selected: selected?.deviceId === row.device.id && selected?.sessionId === row.session.id && selected?.agentId === row.agent.id }"
          @click="choose(row)"
        >
          <DeviceIcon :device="row.device" :size="16" />
          <div>
            <strong>{{ row.session.name }} <span>· {{ row.agent.name }}</span></strong>
            <small>{{ row.device.id }} · {{ row.session.cwd }}</small>
          </div>
          <Activity v-if="row.agent.busy" :size="15" class="spin" />
          <Check v-else-if="selected?.deviceId === row.device.id && selected?.sessionId === row.session.id && selected?.agentId === row.agent.id" :size="16" />
          <GitFork v-else-if="row.agent.kind === 'fork'" :size="15" />
          <MessageSquare v-else :size="15" />
        </button>
        <p v-if="!rows.length" class="hint resume-empty">No matching agents.</p>
      </div>
    </section>
  </div>
</template>
