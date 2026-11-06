# Agent instruction setup

The repository uses one common instruction file and one shared workflow.
The files are instructions, not permission controls or a security sandbox.
Agent behavior also depends on the host, version, trust settings, and higher-priority instructions.

## Files

| File                                                         | Purpose                                                          |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| [AGENTS.md](../AGENTS.md)                                    | Requirements for the complete Toolchain repository.              |
| [Shared SKILL.md](../.agents/skills/toolchain-cli/SKILL.md)  | Development, security review, and archive verification workflow. |
| [CLAUDE.md](../CLAUDE.md)                                    | Imports AGENTS.md through Claude's native import syntax.         |
| [Claude SKILL.md](../.claude/skills/toolchain-cli/SKILL.md)  | Makes the shared workflow discoverable in Claude Code.           |
| [new-app SKILL.md](../.agents/skills/new-app/SKILL.md)       | Steps to add an application to `apps/`.                          |
| [Claude new-app adapter](../.claude/skills/new-app/SKILL.md) | Makes the new-app workflow discoverable in Claude Code.          |
| [Security reviewer](../.claude/agents/security-reviewer.md)  | Claude Code subagent for the separate security review.           |
| [GEMINI.md](../GEMINI.md)                                    | Imports AGENTS.md through Gemini CLI's native import syntax.     |
| [Copilot instructions](../.github/copilot-instructions.md)   | Directs Copilot to the common files.                             |
| [Writing rules](WRITING.md)                                  | English documentation rules based on ASD-STE100 Issue 9.         |

Use the exact uppercase filenames `AGENTS.md` and `SKILL.md`.
Do not add lowercase copies or separate copies of the project rules.
The original instruction adapters are regular text files. They do not require symbolic links or Windows Developer Mode.
No adapter starts a command, installs a package, or changes tool permissions.
The setup does not change global vendor settings.

The [installed third-party skills](INSTALLED_SKILLS.md) use the skills CLI directory layout.
Their Claude entries are relative directory links to the common skill files.
That guide records the Windows link requirements, pinned revisions, local adaptations, and security checks.

## Tool integration

### Codex

Codex reads the root AGENTS.md for repository instructions.
Its repository skill location is `.agents/skills/`.
Invoke `$toolchain-cli` explicitly when necessary.
Skill discovery does not guarantee activation for every request.

References: [AGENTS.md discovery](https://developers.openai.com/codex/guides/agents-md) and [skill discovery](https://developers.openai.com/codex/skills).

### Claude Code

The root CLAUDE.md imports AGENTS.md rather than copying it.
The Claude skill adapter directs the agent to the shared workflow.
Invoke `/toolchain-cli` explicitly when necessary.
Invoke `/new-app` to add an application.

The `security-reviewer` subagent does the separate security review from AGENTS.md in its own context.
It has no edit tools. Its instructions forbid repository writes, Git history changes, publication, and network use.
These instructions are not a sandbox. Its Bash tool can still run any command that the session permits.
Ask Claude to use it after an implementation stage, for example: "use the security-reviewer subagent for this diff".
The subagent reports findings. A human decides how to handle each finding.
The import also supports sessions that do not read AGENTS.md directly.

References: [project instructions and imports](https://code.claude.com/docs/en/memory) and [project skills](https://code.claude.com/docs/en/skills).

### Cursor

Cursor supports the root AGENTS.md directly.
No separate Cursor rule file is necessary.
The project instruction points to the shared workflow when utility work requires it.

Reference: [Cursor rules](https://cursor.com/docs/rules).

### GitHub Copilot

The repository instruction file directs Copilot to AGENTS.md and the shared workflow.
Some Copilot agents also support AGENTS.md directly.
Instruction support differs between chat, agent, and review features.
Check the active feature before relying on a referenced file being read.

Reference: [repository custom instructions](https://docs.github.com/en/copilot/customizing-copilot/adding-custom-instructions-for-github-copilot).

### Gemini CLI

The root GEMINI.md imports AGENTS.md.
The shared workflow remains available through the link in AGENTS.md.
This setup does not add a separate Gemini skill adapter.

Reference: [context files and imports](https://geminicli.com/docs/cli/gemini-md/).

## Verify the active session

1. Start a new agent session in the Toolchain repository.
2. Inspect the host's loaded instructions and available skills.
3. Ask the agent to list its instruction files without changing files.
4. Confirm the Git limits, security review requirement, language rules, and terminal defaults.
5. If a skill is available, confirm that it resolves to the shared workflow.

Claude provides `/context` for memory files.
Gemini CLI provides `/memory show` for loaded context.
Host settings can disable instructions or skill discovery.
If automatic loading is unavailable, attach AGENTS.md and the shared skill explicitly.

Do not start another agent with repository write access only to test instruction discovery.
Static file checks do not prove that every vendor session follows the instructions.

## Maintenance

Change project requirements in AGENTS.md.
Change the development workflow in the shared skill.
Keep the Claude skill description consistent with the shared description.
Keep adapters small and check their relative paths after directory changes.
Read applicable utility documentation before moving a local rule to the project level.
Do not add global permissions, automatic hooks, publication credentials, or network actions to these adapters.
