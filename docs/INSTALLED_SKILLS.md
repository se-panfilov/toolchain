# Installed third-party skills

These skills were installed locally in two installations with `npx skills@1.7.4 add`.
Each installation selected exact Git revisions and the Codex, Claude Code, Cursor, GitHub Copilot, and Gemini CLI targets.
No global skill installation was requested.
The installer used a separate npm cache, empty npm config files, and disabled telemetry and npm installation hooks.
Its user-level bookkeeping used temporary storage outside the repository.

## Inventory

| Skill                     | Source             | Purpose                                                              |
| ------------------------- | ------------------ | -------------------------------------------------------------------- |
| property-based-testing    | trailofbits/skills | Test invariants and generated input cases.                           |
| sharp-edges               | trailofbits/skills | Find unsafe interfaces and configuration defaults.                   |
| differential-review       | trailofbits/skills | Review changes for security regressions.                             |
| supply-chain-risk-auditor | trailofbits/skills | Examine dependency metadata and advisories when requested.           |
| agents-md                 | getsentry/skills   | Maintain concise project instruction files.                          |
| skill-scanner             | getsentry/skills   | Examine skill instructions and scripts before adoption.              |
| code-simplifier           | getsentry/skills   | Improve CLI code readability while preserving behavior and security. |
| doc-coauthoring           | anthropics/skills  | Develop substantial documents and examine reader understanding.      |
| find-bugs                 | getsentry/skills   | Find bugs and vulnerabilities in branch changes without edits.       |
| gha-security-review       | getsentry/skills   | Find exploitable GitHub Actions workflow vulnerabilities.            |
| fp-check                  | trailofbits/skills | Verify whether a suspected vulnerability is a true positive.         |
| second-opinion            | trailofbits/skills | Get an external review from another agent CLI on explicit request.   |
| grilling                  | mattpocock/skills  | Ask plan questions in rounds, each with a recommended answer.        |
| writing-for-agents        | mattpocock/skills  | Apply writing principles to agent instructions and skills.           |

The existing `toolchain-cli` skill remains separate and unchanged.
Project requirements remain in [AGENTS.md](../AGENTS.md).
Installing a skill does not authorize its scripts, network requests, delegation, or changes to user data.
Use the host's applicable permission controls for those actions.
No installed skill lists Bash, Write, Edit, or network tools in `allowed-tools`.
`npm run check:config` enforces this limit. See [Enforced rules](ENFORCED_RULES.md#configuration-check).

## Storage and discovery

The common files are in `.agents/skills/<name>/`.
The installer reports this location for Codex, Cursor, GitHub Copilot, and Gemini CLI.
Claude Code uses relative directory links in `.claude/skills/<name>`.
All fourteen third-party links point inside this repository.
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

| Source             | Git revision                               |
| ------------------ | ------------------------------------------ |
| trailofbits/skills | `2be6433b39e009cd2b6fd3be1895f6b1faa5af9a` |
| getsentry/skills   | `d12f250460ffd961f549dbebf7eeb0cf4afd4c2e` |
| anthropics/skills  | `ca45fc496a3436251f191354091d557da31c15b5` |
| mattpocock/skills  | `a496f5513d4a4cf889bc48e189e579f4b0bdf6aa` |

Local adaptations are stored as reversible patches:

- [code-simplifier](skill-patches/code-simplifier.patch) removes React advice and the blanket preference against exception handlers.
  It adds CLI safety invariants, limited refactoring scope, and verification requirements.
  It preserves the compiled `dist/` output for local execution and npm distribution.
- [agents-md](skill-patches/agents-md.patch) preserves native imports and required project rules regardless of line-count targets.
  It treats upstream package manager and commit examples as examples.
- [skill-scanner](skill-patches/skill-scanner.patch) describes command template syntax without a literal executable template in its entrypoint.
  Its scanner also redacts recognized credentials from JSON report fields.
  It removes Bash from `allowed-tools` and identifies the scanned skill as untrusted data.
- [differential-review](skill-patches/differential-review.patch) removes Bash and Write from `allowed-tools`.
  It gives the report in the reply, or in a temporary file outside the repository without a date in the name.
  It replaces the issue-writer, audit-context-building, and adversarial-modeler integrations, which are not installed.
- [supply-chain-risk-auditor](skill-patches/supply-chain-risk-auditor.patch) removes Write and Bash from `allowed-tools`.
  It permits the collector only on an explicit user request for a dependency audit, after a notice about the network requests and the `gh` token.

The skills added in the second installation have one patch each.
Each patch adds a "Toolchain integration" section before the upstream text.
The fp-check, gha-security-review, and second-opinion patches also change the frontmatter. No other upstream line changes:

- [find-bugs](skill-patches/find-bugs.patch) adds CLI checklist items for subprocesses, files, user data, terminal state, and external effects.
  It adds a fallback base when `gh` is not available.
- [gha-security-review](skill-patches/gha-security-review.patch) keeps the upstream threat model for exploitable findings.
  It adds a separate section for deviations from the stricter Toolchain Actions rules, such as tag-pinned first-party actions.
  It forbids pushes, workflow runs, and payload tests.
  It removes Bash from `allowed-tools`, so commands follow the normal host permission rules.
- [fp-check](skill-patches/fp-check.patch) replaces the plugin agents, which are not installed, with the current session or a general subagent.
  It limits executable PoCs to isolated temporary directories with synthetic data.
  It removes Bash, Write, and Edit from `allowed-tools`, so these tools follow the normal host permission rules.
- [second-opinion](skill-patches/second-opinion.patch) permits the external call only on an explicit user request in the current task.
  It requires confirmation of untracked files, stops on secrets in the patch, and forbids CLI installation or authentication.
  It removes Bash from `allowed-tools`, so provider calls follow the normal host permission rules.
  It adds `disable-model-invocation: true`, so Claude Code starts it only on a user command.
  It runs the provider from an empty temporary directory that contains only the prompt file, not from the repository root.
- [grilling](skill-patches/grilling.patch) requires Russian questions, limits questions to material ones, and makes the subagent lookup optional.
- [writing-for-agents](skill-patches/writing-for-agents.patch) keeps required safety and authorization rules and security prohibitions.
  It identifies `disable-model-invocation` as Claude Code frontmatter.

Each installed skill has LICENSE and UPSTREAM.md files.
Trail of Bits files retain CC-BY-SA-4.0 attribution.
Sentry files retain Apache-2.0 attribution.
Matt Pocock files retain MIT attribution.
The Anthropic README identifies the example skills as Apache-2.0.
Its license text was obtained from the Apache website.
Upstream examples, comments, and license text retain their original formatting.

## First installation checks

The first installation checks covered these items:

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

## Second installation checks

The second installation added find-bugs, gha-security-review, fp-check, second-opinion, grilling, and writing-for-agents.
It used the same installer version, isolation settings, and targets as the first installation.
Each source was a GitHub tree URL with a full commit SHA.
The Trail of Bits and Sentry revisions are the same as in the first installation.
Only the skill directories were installed. Plugin hooks, plugin agents, and workflows from the source repositories were not installed.

The checks covered these items:

- Manual review of each SKILL.md file and of the provider invocation references.
- Pattern searches over the other reference files for commands, URLs, and hidden instructions.
- The installed Sentry scanner over the six directories. It reported no pattern findings.
- Internal links, hard links, symbolic links, executable modes, SVG executable content, and invisible Unicode characters.
- Reversible patch checks against the installed upstream files.
- Offline installer discovery of all six new skills.

Gitleaks was not available in the installation environment. The CI secret scan examines the change.
The installed files contain no scripts.
The gha-security-review references contain example attack payloads and attacker URLs in code blocks.
They describe attacks for the review. They are not instructions.
External audit services can flag these examples.

The second-opinion skill sends a patch and project instructions to OpenAI, Google, or another selected provider.
Installation does not authorize that transfer. The local patch requires an explicit user request in the current task.
The provider CLIs were not installed or executed during this installation.
These limits are instructions, not access controls. Hosts that ignore `allowed-tools` keep their own permission rules.
The empty working directory keeps the repository out of the provider workspace. The Codex read-only sandbox can still read other files that the user account can read.

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
7. Update the provenance manifest to match the reviewed files. `npm run check:config` compares each file with the manifest.

Do not interpret a changed local hash as permission to discard local edits.
