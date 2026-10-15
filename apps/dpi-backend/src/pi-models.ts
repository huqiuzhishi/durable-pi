// DPI_PROVIDER=pi: this machine's Pi setup, through Pi's own loader: ~/.pi/agent/auth.json (API keys and OAuth
// logins), models.json, provider env vars, the extensions in Pi's settings (their providers and some of their tools),
// skills and AGENTS.md files. DPI_PI_EXTENSIONS (colon-separated, like pi's --extension) adds extensions whose
// tool_call handlers guard every durable tool call, the way a security policy guards pi's own.
// <DPI_HOME>/extra-models.json, {"<provider>": [model, ...]}, adds models a provider's own config lacks.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  formatSkillsForPrompt,
  loadProjectContextFiles,
  SessionManager,
  stripFrontmatter,
  wrapRegisteredTool,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Models } from "@earendil-works/pi-ai/models";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import type { ToolCall } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import {
  defineExtension,
  section,
  type Extension,
  type JsonObject,
  type ModelRef,
  type ToolRegistration,
} from "@earendil-works/pi-durable";

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

/** A blocking reason, or the arguments a handler rewrote. */
export type PiGuard = (call: ToolCall, cwd: string, context: Context) => Promise<{ block?: string; arguments?: JsonObject } | undefined>;

export type PiSetup = { models: Models; defaultModel?: ModelRef; extension: Extension; guard?: PiGuard; skills: Skill[] };

/** `/skill:name args` → the skill's instructions plus args, the way pi expands it. Anything else passes through. */
export function expandSkillCommand(text: string, skills: Skill[]) {
  const m = text.match(/^\/skill:(\S+)\s*([\s\S]*)$/);
  const skill = m && skills.find((s) => s.name === m[1]);
  if (!skill) return text;
  const body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  return m[2].trim() ? `${block}\n\n${m[2].trim()}` : block;
}

export async function loadPi(): Promise<PiSetup> {
  // Headless backend must not inherit caller's tmux pane or register with tmux/workmux extensions.
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  // The pi CLI routes fetch through HTTP(S)_PROXY and NO_PROXY; its SDK leaves that to the host.
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) setGlobalDispatcher(new EnvHttpProxyAgent());
  const policyPaths = (process.env.DPI_PI_EXTENSIONS ?? "").split(":").filter(Boolean).map((p) => resolve(p));
  const services = await createAgentSessionServices({
    cwd: homedir(),
    resourceLoaderOptions: { additionalExtensionPaths: policyPaths },
  });
  for (const d of services.diagnostics) console.error(`[pi] ${d.type}: ${d.message}`);
  const { modelRuntime, settingsManager, resourceLoader, agentDir } = services;
  addExtraModels(modelRuntime, join(process.env.DPI_HOME ?? join(homedir(), ".dpi"), "extra-models.json"));
  // A bound Pi session gives extension tools the context and pi.* actions they expect at execution time.
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(homedir()),
    noTools: "all",
  });
  await session.bindExtensions({ mode: "print" });
  const loaded = resourceLoader.getExtensions();
  const policies = policyPaths.map((p) => {
    const ext = loaded.extensions.find((e) => e.resolvedPath === p || e.path === p);
    if (!ext) {
      const why = loaded.errors.find((e) => resolve(e.path) === p)?.error ?? "not loaded";
      throw Error(`DPI_PI_EXTENSIONS: ${p}: ${why}`);
    }
    return ext;
  });
  const handlers = policies.flatMap((e) => e.handlers.get("tool_call") ?? []);
  const guard: PiGuard | undefined = handlers.length
    ? async (call, cwd) => {
        const input = structuredClone(call.arguments) as JsonObject;
        const event = { type: "tool_call", toolCallId: call.id, toolName: call.name, input };
        const ctx = { ...session.extensionRunner.createContext(), cwd };
        for (const handler of handlers) {
          const r = (await handler(event, ctx)) as { block?: boolean; reason?: string } | undefined;
          if (r?.block) return { block: r.reason || `blocked by ${policies.map((e) => e.path).join(", ")}` };
        }
        return JSON.stringify(input) === JSON.stringify(call.arguments) ? undefined : { arguments: input };
      }
    : undefined;
  const tools = loaded.extensions
    .flatMap((e) => [...e.tools.values()])
    .filter((t) => PI_TOOLS.includes(t.definition.name))
    .map((t) => durableTool(t.definition, wrapRegisteredTool(t, session.extensionRunner)));
  const allSkills = resourceLoader.getSkills().skills;
  const skills = formatSkillsForPrompt(allSkills, "read").trim();
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
  return {
    models: modelRuntime,
    defaultModel: provider && modelId ? { provider, modelId } : undefined,
    extension,
    guard,
    skills: allSkills,
  };
}

type ModelRuntime = Awaited<ReturnType<typeof createAgentSessionServices>>["modelRuntime"];
type ModelConfig = NonNullable<Parameters<ModelRuntime["registerProvider"]>[1]["models"]>[number];

/** Re-registering a provider replaces its model list, so pass its current models plus the new ids. */
function addExtraModels(runtime: ModelRuntime, file: string) {
  if (!existsSync(file)) return;
  try {
    const extra = JSON.parse(readFileSync(file, "utf8")) as Record<string, ModelConfig[]>;
    for (const [provider, models] of Object.entries(extra)) {
      const current = runtime.getModels(provider);
      if (!current.length) throw Error(`provider ${provider} has no models to extend`);
      const ids = new Set(current.map((m) => m.id));
      const added = models.filter((m) => !ids.has(m.id));
      if (added.length) runtime.registerProvider(provider, { models: [...(current as readonly ModelConfig[]), ...added] });
    }
  } catch (e) {
    throw Error(`${file}: ${(e as Error).message}`);
  }
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
