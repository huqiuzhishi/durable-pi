// DPI_PROVIDER=pi: the models this machine's Pi uses, through Pi's own loader: ~/.pi/agent/auth.json (API keys and
// OAuth logins), models.json, provider env vars, and providers registered by the extensions in Pi's settings.
import { homedir } from "node:os";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import type { Models } from "@earendil-works/pi-ai/models";
import type { ModelRef } from "@earendil-works/pi-durable";

export type PiModels = { models: Models; defaultModel?: ModelRef };

export async function loadPiModels(): Promise<PiModels> {
  const { modelRuntime, settingsManager, diagnostics } = await createAgentSessionServices({
    cwd: homedir(),
    resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
  });
  for (const d of diagnostics) console.error(`[pi] ${d.type}: ${d.message}`);
  const provider = settingsManager.getDefaultProvider();
  const modelId = settingsManager.getDefaultModel();
  return { models: modelRuntime, defaultModel: provider && modelId ? { provider, modelId } : undefined };
}
