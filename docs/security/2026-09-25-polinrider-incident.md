# Incident: config-injection worm force-pushed to every branch (2026-09-25)

**Status:** contained on GitHub; secrets rotation and branch restore tracked below.
**Campaign:** PolinRider (publicly attributed to DPRK / Lazarus) — see references.

## What happened

| Time (UTC) | Event |
|---|---|
| 2026-09-07 14:32 | Owner pushes `21f3060` to `main` (last good commit). |
| 2026-09-25 22:26:10 | Using a collaborator's credentials, the worm amends `21f3060` (same author, message and author date; committer timezone +0200, CRLF line endings) and force-pushes it as `d6bbe68`. |
| 22:26:10–22:27:01 | 14 force-pushes in 51 s — every branch of the repo is rewritten the same way. |
| 22:26:44 | Vercel builds `d6bbe68` to **Production** (success). |
| 22:27–22:41 | Vercel builds all 14 infected branches as **Preview** deployments. |
| 22:27–22:29 | Same credentials rewrite the collaborator's own repos and a third party's repo. |
| 2026-09-26 | Detected while updating a PR branch; merge aborted before anything ran locally. |

The collaborator appears to be a victim: the push pattern (every writable repo within ~3 minutes) is the worm's documented propagation, which amends the latest commit with `git commit --amend` and force-pushes with the victim's stored Git credentials.

## What the injected commit added

- `postcss.config.mjs`: an obfuscated payload appended after ~150 spaces on the last line, plus a CommonJS `require` shim so it can load Node modules. Runs on every `next dev` / `next build`.
- `src/app/api/auth/[...nextauth]/public/fonts/*`: a fake Font Awesome set; `fa-solid-900.woff2` is the same payload as JavaScript (no `wOF2` header). A decoy README describes a "Blockchain Explorer" app.
- `.vscode/tasks.json` + `settings.json`: a hidden task that runs the fake font with `node` whenever the folder is opened, with automatic tasks force-enabled.
- `.gitignore`: stopped ignoring `.env`, `.env.development`, `.env.production` and `.vscode`.

## What the payload does (static analysis, never executed)

Four layers: string-table obfuscation → a seeded character shuffle → a dictionary decompressor → the loader, run via the `Function` constructor. The loader:

1. Reads the latest Ethereum transaction sent by the attacker's address (public RPCs / Blockscout) and decodes two IPv4 addresses from its `to` field.
2. Downloads XOR-encrypted JavaScript from `http://<ip>:443/0x/cls` and evaluates it **in-process** — in a Vercel build that means with every build environment variable available.
3. Downloads `http://<ip>:443/0x/ls` and starts it as a **detached** `node -e` process that outlives the build.

The data-stealing stage is served by the C2 and can change at any time.

## Indicators of compromise

- Campaign marker id: `9-7721` (assigned on `global` at the start of each payload)
- Ethereum dead-drop sender: `0xa322E5f3D311D3080e6f0121063e9aDC2490Ef1a` (publishes a pointer about every 1,000 blocks)
- C2 as of 2026-09-26: `166.88.134.75` ports 80/443, paths `/0x/cls`, `/0x/ls`; request header `Sec-V: A9-7721`
- Files: config files with long trailing lines, `.woff2` files starting with JavaScript, `.vscode/tasks.json` with `runOn: folderOpen`, `temp_auto_push.bat`

## Response

- [x] Removed the compromised collaborator's write access.
- [x] Verified no webhooks, deploy keys, Actions secrets or workflows were added.
- [x] Verified the owner's machine and local checkouts are clean (no payload processes, no C2 connections, no infected files).
- [x] Added `scripts/security/preflight.mjs`, run before `next dev` / `next build` (package.json, vercel.json) and on every push/PR (GitHub Actions). It blocks all footprints above; tested against the real infected trees.
- [ ] Restore all 15 branches to their pre-attack commits (differences were only the malware and CRLF churn).
- [ ] Ruleset: block force-pushes and deletions on all branches; require PRs into `main`.
- [ ] Vercel: roll Production back / redeploy clean `main`; delete the 14 infected Preview deployments.
- [ ] Rotate every Production and Preview secret (Neon password, `AUTH_SECRET`, Upstash, `AI_TOKEN_ENCRYPTION_KEY`, any others); review Neon connection logs and Vercel tokens/activity.
- [ ] Collaborator: revoke GitHub tokens, SSH keys and OAuth grants; clean their machine before regaining access.
- [ ] Editors: `"task.allowAutomaticTasks": "off"` in VS Code and Cursor user settings.

## References

- OpenSourceMalware — PolinRider: https://github.com/OpenSourceMalware/PolinRider
- The Hacker News — PolinRider campaign: https://thehackernews.com/2026/07/north-korean-hackers-publish-108.html
- GitHub Community discussion #188732 (obfuscated code in next/postcss configs)
- Case study — Git config injection worm: https://sharonrosario.space/case-studies/git-worm-malware-incident
