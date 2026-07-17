import {
  type ModelCapabilities,
  type PiSettings,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess } from "effect/unstable/process";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import { resolvePiProcessEnv } from "./PiEnvironment.ts";
import {
  extractAvailableModels,
  extractSlashCommands,
  makePiRpcTransport,
  piModelInfoToServerModel,
} from "./PiRpcClient.ts";

const PROVIDER = ProviderDriverKind.make("pi");

const PI_PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "Early Access",
  // Pi has no T3 interaction-mode mapping (plan/default); hide the unused toggle.
  showInteractionModeToggle: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const PI_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const runPiVersion = (piSettings: PiSettings, environment: NodeJS.ProcessEnv) =>
  Effect.suspend(() => {
    const binaryPath = piSettings.binaryPath || "pi";
    return Effect.gen(function* () {
      const spawnCommand = yield* resolveSpawnCommand(binaryPath, ["--version"], {
        env: environment,
        extendEnv: true,
      });
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        extendEnv: true,
        shell: spawnCommand.shell,
      });
      return yield* spawnAndCollect(binaryPath, command);
    });
  });

export interface PiCatalogDiscovery {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
}

/** Discover models + plugin/extension slash commands via a short-lived `pi --mode rpc` session. */
export const discoverPiCatalogViaRpc = Effect.fn("discoverPiCatalogViaRpc")(
  function* (piSettings: PiSettings, cwd: string, environment: NodeJS.ProcessEnv) {
    const transport = yield* makePiRpcTransport({
      binaryPath: piSettings.binaryPath || "pi",
      // Keep extensions enabled so installed plugins/packages contribute commands.
      args: ["--mode", "rpc", "--no-session"],
      cwd,
      env: resolvePiProcessEnv(piSettings, environment),
      onExit: Effect.void,
    });
    const modelsResponse = yield* transport.request(
      { type: "get_available_models" },
      "pi-model-discovery",
      PI_MODEL_DISCOVERY_TIMEOUT_MS,
    );
    const commandsResponse = yield* transport.request(
      { type: "get_commands" },
      "pi-command-discovery",
      PI_MODEL_DISCOVERY_TIMEOUT_MS,
    );
    return {
      models: extractAvailableModels(modelsResponse).map(piModelInfoToServerModel),
      slashCommands: extractSlashCommands(commandsResponse),
    } satisfies PiCatalogDiscovery;
  },
  Effect.scoped,
  Effect.timeoutOption(PI_MODEL_DISCOVERY_TIMEOUT_MS),
  Effect.map(
    Option.getOrElse(
      () =>
        ({
          models: [],
          slashCommands: [],
        }) satisfies PiCatalogDiscovery,
    ),
  ),
  Effect.catchCause((cause) =>
    Effect.logWarning("Pi catalog discovery failed", { cause }).pipe(
      Effect.as({
        models: [],
        slashCommands: [],
      } satisfies PiCatalogDiscovery),
    ),
  ),
);

const modelsFromSettings = (
  piSettings: PiSettings,
  discovered: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> =>
  providerModelsFromSettings(discovered, PROVIDER, piSettings.customModels, EMPTY_CAPABILITIES);

export const buildInitialPiProviderSnapshot = Effect.fn("buildInitialPiProviderSnapshot")(
  function* (piSettings: PiSettings) {
    const checkedAt = yield* nowIso;
    const models = modelsFromSettings(piSettings, []);

    if (!piSettings.enabled) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Pi availability...",
      },
    });
  },
);

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = yield* nowIso;
  const fallbackModels = modelsFromSettings(piSettings, []);
  const processEnv = resolvePiProcessEnv(piSettings, environment);

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runPiVersion(piSettings, processEnv).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Pi CLI (`pi`) is not installed or not on PATH."
          : "Failed to execute Pi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but timed out while running `pi --version`.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);

  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail ?? "Pi CLI returned an error during health check.",
      },
    });
  }

  // Pass the raw caller env; discoverPiCatalogViaRpc applies codingAgentDir itself.
  const catalog = yield* discoverPiCatalogViaRpc(piSettings, cwd, environment);
  const models = modelsFromSettings(piSettings, catalog.models);

  // no auth query in pi; get_available_models only lists once a key is configured in ~/.pi/agent
  const authenticated = catalog.models.length > 0;

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: piSettings.enabled,
    checkedAt,
    models,
    slashCommands: catalog.slashCommands,
    probe: {
      installed: true,
      version: parsedVersion,
      status: authenticated ? "ready" : "warning",
      auth: { status: authenticated ? "authenticated" : "unknown", type: "pi" },
      ...(authenticated
        ? {}
        : {
            message:
              "Pi is installed but no models are available. Configure a provider or API key in ~/.pi/agent (e.g. run `pi`) so models appear.",
          }),
    },
  });
});
