import type { PiSettings } from "@t3tools/contracts";

import { expandHomePath } from "../../pathExpansion.ts";

/**
 * Resolve the process environment for a Pi CLI spawn.
 *
 * When `codingAgentDir` is set, it becomes `PI_CODING_AGENT_DIR` so Pi loads
 * auth/models/settings/extensions/packages from that directory — the same
 * config surface the `pi` CLI uses.
 */
export function resolvePiProcessEnv(
  settings: Pick<PiSettings, "codingAgentDir">,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const codingAgentDir = settings.codingAgentDir.trim();
  if (codingAgentDir.length === 0) {
    return baseEnv;
  }
  return {
    ...baseEnv,
    PI_CODING_AGENT_DIR: expandHomePath(codingAgentDir),
  };
}
