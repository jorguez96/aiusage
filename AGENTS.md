# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

- OpenCode Go plan accounting is centralized in `packages/core/src/plan-usage.ts`; keep its `(gateway, model)` boundary intact when adding consumers or refreshing the card snapshot.

- Grok file watermarks are invalidated by `CURRENT_GROK_PARSER_VERSION` in `packages/cli/src/watermark.ts`; bump it whenever Grok token accounting changes so existing logs are replayed.

- Gemini CLI 0.60 chats live under `~/.gemini/tmp` (`GEMINI_HOME/tmp`) and are parsed by `GeminiParser` in `packages/core/src/parsers/gemini.ts`; the CLI persists each assistant message twice under the same id (plain, then `toolCalls`-enriched), so the parser dedupes by message id and counts usage once.

- The opencode/grok quota cards read `<AIUSAGE_DIR>/quota-bridge.json` (see `packages/cli/src/quota.ts`); refresh it with `aiusage quota-bridge` (`packages/cli/src/commands/quota-bridge.ts`) on a schedule — no in-repo trigger writes it.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
