import { describe, expect, it } from "@effect/vitest";

import { expandHomePath } from "../../pathExpansion.ts";
import { resolvePiProcessEnv } from "./PiEnvironment.ts";

describe("resolvePiProcessEnv", () => {
  it("returns the base env unchanged when codingAgentDir is empty", () => {
    const base = { PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/existing" };
    expect(resolvePiProcessEnv({ codingAgentDir: "" }, base)).toBe(base);
    expect(resolvePiProcessEnv({ codingAgentDir: "   " }, base)).toBe(base);
  });

  it("sets PI_CODING_AGENT_DIR from codingAgentDir, expanding ~", () => {
    const resolved = resolvePiProcessEnv(
      { codingAgentDir: "~/.pi/work" },
      { PATH: "/usr/bin", KEEP: "1" },
    );
    expect(resolved).toEqual({
      PATH: "/usr/bin",
      KEEP: "1",
      PI_CODING_AGENT_DIR: expandHomePath("~/.pi/work"),
    });
  });
});
