/**
 * The agent registry: every adapter this relay knows, built from `config.agents.<id>`
 * (`enabled: false` turns one off). Adding an agent = one adapter file + one line here.
 */
import { AgentAdapter } from "./base.js";
import { PenguinAdapter } from "./penguin.js";
import { CodexAdapter } from "./codex.js";
import { ClaudeAdapter } from "./claude.js";
import { GrokAdapter } from "./grok.js";
import { DshAdapter } from "./dsh.js";
import { PiAdapter } from "./pi.js";
import { HermesAdapter } from "./hermes.js";

/**
 * GrokBot (Cursor's "Sand" app) runs its agent on a remote gateway and exposes no local
 * API, CLI or stream; there is nothing to drive from here.
 */
class GrokBotAdapter extends AgentAdapter {
  constructor(options) {
    super("grokbot", options);
  }
  async available() {
    return { ok: false, reason: "GrokBot 的智能体运行在云端，本机没有可调用的接口" };
  }
}

const FACTORIES = {
  penguin: (o) => new PenguinAdapter(o),
  codex: (o) => new CodexAdapter(o),
  claude: (o) => new ClaudeAdapter(o),
  grok: (o) => new GrokAdapter(o),
  dsh: (o) => new DshAdapter(o),
  pi: (o) => new PiAdapter(o),
  hermes: (o) => new HermesAdapter(o),
  grokbot: (o) => new GrokBotAdapter(o),
};

export const AGENT_IDS = Object.keys(FACTORIES);

/** Aliases people type after `/ht@`. */
const ALIASES = {
  penguinharness: "penguin",
  ph: "penguin",
  cc: "claude",
  "claude-code": "claude",
  claudecode: "claude",
  deepseek: "dsh",
  ds: "dsh",
  "deepseek-harness": "dsh",
  xai: "grok",
  "pi-agent": "pi",
};

export function normalizeAgentId(raw) {
  const id = String(raw ?? "").trim().toLowerCase();
  if (id === "") return null;
  if (FACTORIES[id]) return id;
  return ALIASES[id] ?? null;
}

export function buildAgents(cfg) {
  const agents = new Map();
  for (const [id, make] of Object.entries(FACTORIES)) {
    const options = cfg.agents?.[id] ?? {};
    if (options.enabled === false) continue;
    agents.set(id, make(options));
  }
  return agents;
}
