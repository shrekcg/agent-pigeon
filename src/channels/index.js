/**
 * The channel registry. Feishu is the one implemented channel; DingTalk, QQ and WeChat are
 * listed as "coming soon" so the app can show where they will go, with no switches behind
 * them. Adding one = a directory under channels/ implementing the Channel contract + its
 * `make` here; the hub, the agents and the app need no change.
 */
import { FeishuChannel } from "./feishu/index.js";

export const CHANNELS = {
  feishu: { label: "飞书", make: (options, hub) => new FeishuChannel(options, hub) },
  dingtalk: { label: "钉钉", make: null },
  qq: { label: "QQ", make: null },
  wechat: { label: "微信", make: null },
};

export function buildChannels(cfg, hub) {
  const out = [];
  for (const [id, spec] of Object.entries(CHANNELS)) {
    if (!spec.make) continue;
    const options = { defaultAgent: cfg.defaultAgent, ...(cfg.channels?.[id] ?? {}) };
    if (options.enabled === false) continue;
    out.push(spec.make(options, hub));
  }
  return out;
}
