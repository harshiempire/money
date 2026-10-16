# pstack (vendored)

| Field | Value |
|-------|--------|
| **Plugin** | pstack |
| **Version** | 0.15.25 |
| **Author** | Lauren Tan |
| **License** | MIT (see `pstack-LICENSE` in this directory) |
| **Upstream** | https://github.com/cursor/plugins/tree/main/pstack |
| **Marketplace** | https://cursor.com/marketplace/cursor/pstack |
| **Vendored** | 2026-10-16 |

## Layout in this repo

- `.cursor/skills/` — all pstack skills (from upstream `pstack/skills/`), plus this file
- `.cursor/agents/` — `poteto-agent` and `comment-sicko` subagents (from upstream `pstack/agents/`)
- `.cursor/pstack/` — upstream `README.md`, `docs/`, `assets/`, and `.cursor-plugin/plugin.json` for reference

No bundled Cursor rules ship with pstack. Run `/setup-pstack` locally to create `~/.cursor/rules/pstack-models.mdc` with your model choices.

## Not installed

- **benny automations** (`pstack/automations/benny/`) — optional; copy to `.cursor/automations/benny/` via [FOR_AGENTS.md](https://github.com/cursor/plugins/blob/main/pstack/automations/benny/FOR_AGENTS.md) if you want Slack triage/fix automations
- **cursor-team-kit** — separate plugin (`/deslop`, `control-cli`, `control-ui`); install from the Cursor marketplace if needed

## Updating

Replace the directories above from `https://github.com/cursor/plugins` at tag/commit matching the desired `version` in `.cursor/pstack/plugin.json`, then update this file.
