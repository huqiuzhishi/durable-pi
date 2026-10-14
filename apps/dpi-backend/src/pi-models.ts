// DPI_PROVIDER=pi: this machine's Pi setup, through Pi's own loader: ~/.pi/agent/auth.json (API keys and OAuth
// logins), models.json, provider env vars, the extensions in Pi's settings (their providers and some of their tools),
// skills and AGENTS.md files.
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  formatSkillsForPrompt,
  loadProjectContextFiles,
  SessionManager,
  wrapRegisteredTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Models } from "@earendil-works/pi-ai/models";
import { defineExtension, section, type Extension, type ModelRef, type ToolRegistration } from "@earendil-works/pi-durable";

/** Pi extension tools that need neither a UI nor Pi's own session; the others only work inside Pi. */
export const PI_TOOLS = [
  "web_search",
  "fetch_content",
  "get_search_content",
  "read_pdf",
  "document_parse",
  "document_search",
  "document_screenshot",
  "memory_recall",
];

export type PiSetup = { models: Models; defaultModel?: ModelRef; extension: Extension };

export async function loadPi(): Promise<PiSetup> {
  const services = await createAgentSessionServices({ cwd: homedir() });
  for (const d of services.diagnostics) console.error(`[pi] ${d.type}: ${d.message}`);
  const { modelRuntime, settingsManager, resourceLoader, agentDir } = services;
  // A bound Pi session gives extension tools the context and pi.* actions they expect at execution time.
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(homedir()),
    noTools: "all",
  });
  await session.bindExtensions({ mode: "print" });
  const tools = resourceLoader
    .getExtensions()
    .extensions.flatMap((e) => [...e.tools.values()])
    .filter((t) => PI_TOOLS.includes(t.definition.name))
    .map((t) => durableTool(t.definition, wrapRegisteredTool(t, session.extensionRunner)));
  const skills = formatSkillsForPrompt(resourceLoader.getSkills().skills, "read").trim();
  const extension = defineExtension({
    name: "pi",
    tools,
    sections: [
      section("project_context", (input) => {
        const files = loadProjectContextFiles({ cwd: input.agent.cwd ?? homedir(), agentDir });
        if (!files.length) return undefined;
        return [
          "Project-specific instructions and guidelines:",
          ...files.map((f) => `<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`),
        ].join("\n\n");
      }),
      section("skills", () => skills || undefined),
    ],
  });
  const provider = settingsManager.getDefaultProvider();
  const modelId = settingsManager.getDefaultModel();
  return { models: modelRuntime, defaultModel: provider && modelId ? { provider, modelId } : undefined, extension };
}

function durableTool(def: ToolDefinition, tool: ReturnType<typeof wrapRegisteredTool>): ToolRegistration {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    executionMode: def.executionMode,
    prepareArguments: def.prepareArguments,
    async execute(args, api, context) {
      // The Pi session's cwd is the backend's home: resolve a relative `path` against this agent's folder instead.
      const cwd = (await api.agent(context)).cwd;
      const path = (args as { path?: unknown }).path;
      if (cwd && typeof path === "string" && !path.startsWith("~") && !isAbsolute(path))
        args = { ...(args as object), path: resolve(cwd, path) };
      const result = await tool.execute(api.callId, args, context.abortSignal, () => {});
      return { content: result.content };
    },
  };
}
