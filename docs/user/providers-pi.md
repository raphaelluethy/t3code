# Pi

T3 Code uses your existing Pi installation, including its authentication, models, extensions,
skills, context files, and native session history.

## Setup

1. Install Pi 0.80.5 or newer on the machine running the T3 Code server.
2. Run `pi` in a terminal and finish your usual provider login or API-key setup.
3. Enable Pi in **Settings → Providers**, then refresh the provider.

Set the binary path if `pi` is not on the server's `PATH`. Launch arguments and provider environment
variables can select a custom agent directory, endpoint, or model configuration. T3 Code controls
RPC mode and session selection, so launch arguments cannot override those flags.

The **Pi default** model uses Pi's own configured model. Discovered models expose their supported
thinking levels. Pi skills appear in the composer's `$` menu, and `/compact` uses native Pi
compaction. Sessions resume from Pi's own session files; rollback updates the native resume target.

## Permissions and extensions

Pi loads its normal user and project extensions. Blocking `select`, `confirm`, `input`, and `editor`
dialogs appear in the composer. The T3 extension also exposes the environment's available MCP tools.

- **Supervised** asks before commands, file changes, and extension tools; read-only tools continue.
- **Auto-accept edits** allows Pi's edit and write tools, and asks before other tools.
- **Full access** allows tools without T3 approval prompts.

Pi does not support an AI approval reviewer. An existing Auto setting behaves as Supervised.
This policy covers Pi tool calls; trusted extension code still follows Pi's own trust model.

## Troubleshooting

If discovery fails, T3 keeps the **Pi default** model available so an interactive session can handle
startup prompts. Check `pi --version`, Pi authentication, and project trust when models, extensions,
or skills are missing. Refresh the provider after changing configuration.
