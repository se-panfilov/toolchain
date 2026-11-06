# Installed third-party skills

These skills were installed locally with `npx skills@1.7.4 add`.
The installation selected exact Git revisions and the Codex, Claude Code, Cursor, GitHub Copilot, and Gemini CLI targets.
No global skill installation was requested.
The installer used a separate npm cache, empty npm config files, and disabled telemetry and npm installation hooks.
Its user-level bookkeeping used temporary storage outside the repository.

## Inventory

| Skill | Source | Purpose |
| --- | --- | --- |
| property-based-testing | trailofbits/skills | Test invariants and generated input cases. |
| sharp-edges | trailofbits/skills | Find unsafe interfaces and configuration defaults. |
| differential-review | trailofbits/skills | Review changes for security regressions. |
| supply-chain-risk-auditor | trailofbits/skills | Examine dependency metadata and advisories when requested. |
| agents-md | getsentry/skills | Maintain concise project instruction files. |
| skill-scanner | getsentry/skills | Examine skill instructions and scripts before adoption. |
| code-simplifier | getsentry/skills | Improve CLI code readability while preserving behavior and security. |
| doc-coauthoring | anthropics/skills | Develop substantial documents and examine reader understanding. |

The existing `toolchain-cli` skill remains separate and unchanged.
Project requirements remain in [AGENTS.md](../AGENTS.md).
Installing a skill does not authorize its scripts, network requests, delegation, or changes to user data.
Use the host's applicable permission controls for those actions.

## Storage and discovery

The common files are in `.agents/skills/<name>/`.
The installer reports this location for Codex, Cursor, GitHub Copilot, and Gemini CLI.
Claude Code uses relative directory links in `.claude/skills/<name>`.
All eight new links point inside this repository.
The existing `toolchain-cli` adapter stays a regular file.

Native host discovery depends on the installed host version and settings.
The installer list is not a test of a live vendor session.
Use [the agent setup guide](AI_AGENTS.md) to examine a new session.

On Windows, Git must preserve symbolic links for the new Claude entries.
If links are unavailable, use the installer's copy mode for the selected Claude skills.
Apply the local patches to those copies too.
Do not replace the existing root CLAUDE.md import.

## Revisions and local changes

[skills-lock.json](../skills-lock.json) records the upstream sources, Git revisions, and installer hashes.
[The provenance manifest](skill-provenance.json) records installer integrity, license identifiers, and local file hashes.
The lockfile describes upstream versions. It does not preserve local adaptations or added license files by itself.

| Source | Git revision |
| --- | --- |
| trailofbits/skills | `2be6433b39e009cd2b6fd3be1895f6b1faa5af9a` |
| getsentry/skills | `d12f250460ffd961f549dbebf7eeb0cf4afd4c2e` |
| anthropics/skills | `ca45fc496a3436251f191354091d557da31c15b5` |

Local adaptations are stored as reversible patches:

- [code-simplifier](skill-patches/code-simplifier.patch) removes React advice and the blanket preference against exception handlers.
  It adds CLI safety invariants, limited refactoring scope, and verification requirements.
- [agents-md](skill-patches/agents-md.patch) preserves native imports and required project rules regardless of line-count targets.
  It treats upstream package manager and commit examples as examples.
- [skill-scanner](skill-patches/skill-scanner.patch) describes command template syntax without a literal executable template in its entrypoint.
  Its scanner also redacts recognized credentials from JSON report fields.

Each installed skill has LICENSE and UPSTREAM.md files.
Trail of Bits files retain CC-BY-SA-4.0 attribution.
Sentry files retain Apache-2.0 attribution.
The Anthropic README identifies the example skills as Apache-2.0.
Its license text was obtained from the Apache website.
Upstream examples, comments, and license text retain their original formatting.

## Security checks

The installation checks covered these items:

- SHA-256 comparison of existing instructions and both `toolchain-cli` entrypoints before and after installation.
- YAML parsing, required skill metadata, and Python syntax without imports or bytecode writes.
- Internal file links, hard links, hooks, command templates, and SVG executable content.
- The installed Sentry scanner over all eight canonical skill directories.
- Manual classification of scanner findings and review of executable boundaries.
- Reversible patch checks and a secret scan with Gitleaks.
- Offline installer discovery of all eight new skills and `toolchain-cli`.
- A regression test confirms secret redaction and read-only scanner behavior with a synthetic token.

The scanner reports patterns, not verified vulnerabilities.
The remaining sharp-edges findings concern a defensive checklist phrase and an emoji with Unicode joiners.
The scanner finds its own threat examples and detection expressions in skill-scanner.
The dependency auditor contains four upstream test files.
Those files are not part of reHistory's explicit Node.js test command.
No remaining finding was identified as an active malicious instruction during this review.

The dependency collector and its network requests were not executed.
Its source includes registry lookups and a GitHub token lookup through `gh auth token`.
Do not run it without an authorized dependency audit and an appropriate credential environment.
The current environment has no `uv` command.
Future script execution needs its documented runtime and dependencies, or a supported manual fallback.

Python syntax checks do not establish collector correctness.
The checks are not a complete upstream code audit or a security certificate.
The reHistory runtime and package metadata were not changed.

## Scanner regression check

Use a Python interpreter with PyYAML installed.
Set `SCANNER_PYTHON` to that interpreter when the default `python3` lacks PyYAML.
Run the check from the repository root:

```sh
node --test tests/skills/skill-scanner.test.ts
```

The check creates only temporary synthetic data.
It does not execute the example script found by the scanner.
Secret redaction recognizes known patterns. It cannot guarantee that every secret is identified.

## Updates

**CAUTION: Reinstallation can replace local adaptations and license additions.**

1. Save the current skill files and local patches before an update.
2. Review the selected source revision and the installer overwrite summary.
3. Update only the selected skills.
4. Compare upstream changes with each local patch before applying it.
5. Restore the relevant license and attribution files.
6. Repeat security, metadata, link, and patch checks.
7. Update the provenance manifest to match the reviewed files.

Do not interpret a changed local hash as permission to discard local edits.
