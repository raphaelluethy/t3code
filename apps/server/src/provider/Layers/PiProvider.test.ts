import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { PiSettings } from "@t3tools/contracts";

import { buildInitialPiProviderSnapshot, checkPiProviderStatus } from "./PiProvider.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

// fake `pi`: `--version` exits 0; for RPC, answer get_available_models + get_commands
// then exit. Responding only after a request avoids racing pending-request registration.
const healthyPiScript = (modelsJson: string, commandsJson = "[]") =>
  [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then',
    '  printf "pi 0.80.10\\n"',
    "  exit 0",
    "fi",
    "answered_models=0",
    "answered_commands=0",
    "while IFS= read -r line; do",
    '  id=$(printf "%s" "$line" | sed -n \'s/.*"id":"\\([^"]*\\)".*/\\1/p\')',
    '  [ -z "$id" ] && id="pi-discovery"',
    '  if printf "%s" "$line" | grep -q \'"type":"get_available_models"\'; then',
    `    printf '{"type":"response","command":"get_available_models","id":"%s","success":true,"data":{"models":${modelsJson}}}\\n' "$id"`,
    "    answered_models=1",
    '  elif printf "%s" "$line" | grep -q \'"type":"get_commands"\'; then',
    `    printf '{"type":"response","command":"get_commands","id":"%s","success":true,"data":{"commands":${commandsJson}}}\\n' "$id"`,
    "    answered_commands=1",
    "  fi",
    '  if [ "$answered_models" = "1" ] && [ "$answered_commands" = "1" ]; then',
    "    exit 0",
    "  fi",
    "done",
    "",
  ].join("\n");

const HEALTHY_PI_SCRIPT_NO_MODELS = healthyPiScript("[]");
const HEALTHY_PI_SCRIPT_WITH_MODELS = healthyPiScript(
  '[{"provider":"openai","id":"gpt-4o"}]',
  '[{"name":"session-name","description":"Rename session","source":"extension"},{"name":"t3-approval-gate","source":"extension"},{"name":"skill:demo","description":"Demo skill","source":"skill"}]',
);

describe("buildInitialPiProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiProviderSnapshot(decodePiSettings({ enabled: false }));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiProviderSnapshot(decodePiSettings({ enabled: true }));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Pi");
    }),
  );

  it.effect("appends custom models from settings to the catalog", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiProviderSnapshot(
        decodePiSettings({ enabled: true, customModels: ["anthropic/claude-custom"] }),
      );
      expect(snapshot.models.map((model) => model.slug)).toContain("anthropic/claude-custom");
      expect(
        snapshot.models.find((model) => model.slug === "anthropic/claude-custom")?.isCustom,
      ).toBe(true);
    }),
  );
});

it.layer(NodeServices.layer)("checkPiProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(
        decodePiSettings({ enabled: true, binaryPath: "/definitely/not/installed/pi-binary" }),
        process.cwd(),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH/);
    }),
  );

  it.effect("returns a disabled snapshot without probing when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(
        decodePiSettings({ enabled: false }),
        process.cwd(),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-version-" });
          const piPath = path.join(dir, "pi");
          yield* fs.writeFileString(
            piPath,
            ["#!/bin/sh", 'printf "pi error\\n" >&2', "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(piPath, 0o755);

          return yield* checkPiProviderStatus(
            decodePiSettings({ enabled: true, binaryPath: piPath }),
            dir,
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(typeof snapshot.message).toBe("string");
    }),
  );

  it.effect("reports ready/authenticated when discovered models are available", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-ready-" });
          const piPath = path.join(dir, "pi");
          yield* fs.writeFileString(piPath, HEALTHY_PI_SCRIPT_WITH_MODELS);
          yield* fs.chmod(piPath, 0o755);
          return yield* checkPiProviderStatus(
            decodePiSettings({ enabled: true, binaryPath: piPath }),
            dir,
          );
        }),
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.map((model) => model.slug)).toContain("openai/gpt-4o");
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual([
        "session-name",
        "skill:demo",
      ]);
      expect(snapshot.showInteractionModeToggle).toBe(false);
    }),
  );

  it.effect("does not treat custom-only models as authenticated", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-custom-only-" });
          const piPath = path.join(dir, "pi");
          yield* fs.writeFileString(piPath, HEALTHY_PI_SCRIPT_NO_MODELS);
          yield* fs.chmod(piPath, 0o755);
          return yield* checkPiProviderStatus(
            decodePiSettings({ enabled: true, binaryPath: piPath, customModels: ["x/y"] }),
            dir,
          );
        }),
      );
      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.models.map((model) => model.slug)).toContain("x/y");
    }),
  );

  it.effect("degrades to warning/unknown when the CLI is healthy but no models are available", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-nomodels-" });
          const piPath = path.join(dir, "pi");
          yield* fs.writeFileString(piPath, HEALTHY_PI_SCRIPT_NO_MODELS);
          yield* fs.chmod(piPath, 0o755);
          return yield* checkPiProviderStatus(
            decodePiSettings({ enabled: true, binaryPath: piPath }),
            dir,
          );
        }),
      );
      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.message).toMatch(/no models/i);
    }),
  );
});
