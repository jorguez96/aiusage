# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

- OpenCode Go plan accounting is centralized in `packages/core/src/plan-usage.ts`; keep its `(gateway, model)` boundary intact when adding consumers or refreshing the card snapshot.

- Grok file watermarks are invalidated by `CURRENT_GROK_PARSER_VERSION` in `packages/cli/src/watermark.ts`; bump it whenever Grok token accounting changes so existing logs are replayed.

- Gemini CLI 0.60 chats live under `~/.gemini/tmp` (`GEMINI_HOME/tmp`) and are parsed by `GeminiParser` in `packages/core/src/parsers/gemini.ts`; the CLI persists each assistant message twice under the same id (plain, then `toolCalls`-enriched), so the parser dedupes by message id and counts usage once.

- The opencode/grok quota cards read `<AIUSAGE_DIR>/quota-bridge.json` (see `packages/cli/src/quota.ts`); refresh it with `aiusage quota-bridge` (`packages/cli/src/commands/quota-bridge.ts`) on a schedule — no in-repo trigger writes it.

- Cross-device usage merges at the record level with `aiusage sync` (S3 backend) against a local s3rver store on the Windows side (`C:\Users\jorgu\.aiusage\s3store`, port 9000; WSL reaches it via the Hyper-V host gateway IP). Serve topology: Linux `:45680` from the fork checkout reads `~/.aiusage/cache.db`; Windows `:3847` from `C:\Users\jorgu\aiusage-fork` reads `C:\Users\jorgu\.aiusage\cache.db`; the 15-min `AIUsage-WSL-Sync` task runs parse+sync on both sides (`wsl-sync.cmd` / `wsl-sync.sh`). Never re-enable session-log rsync across machines: sync ids are per-device, so dual-parsed sessions double-count after merge. Never point the scheduled parse at the upstream package build — only fork builds carry the sync provenance fix. Quota bridge stays on its ~5 min schedule, untouched by sync.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
