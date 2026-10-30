# Agent instruction setup

[AGENTS.md](../AGENTS.md) contains repository requirements. The [shared skill](../.agents/skills/toolchain-cli/SKILL.md) defines the development, security review, and archive verification workflow.
These files are instructions, not permission controls or a sandbox.
Behavior depends on the host, version, trust settings, and higher-priority instructions.

## Files and discovery

Use uppercase `AGENTS.md` and `SKILL.md`. Do not add lowercase or duplicate rule files.
The original adapters are regular text files, without symbolic-link or Windows Developer Mode requirements.
They do not run commands, install packages, change permissions, or modify global vendor settings.

| Host           | Repository integration                                                                                                                                                                         | Explicit activation and references                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex          | Reads root AGENTS.md. Discovers skills in `.agents/skills/`.                                                                                                                                   | Use `$toolchain-cli` when necessary. Discovery does not guarantee activation. [Instructions](https://developers.openai.com/codex/guides/agents-md), [skills](https://developers.openai.com/codex/skills). |
| Claude Code    | [CLAUDE.md](../CLAUDE.md) imports AGENTS.md, including in sessions without direct AGENTS.md support. [Skill adapter](../.claude/skills/toolchain-cli/SKILL.md) references the shared workflow. | Use `/toolchain-cli` when necessary. [Imports](https://code.claude.com/docs/en/memory), [skills](https://code.claude.com/docs/en/skills).                                                                 |
| Cursor         | Reads root AGENTS.md, which references the shared workflow. No separate Cursor rule file is necessary.                                                                                         | [Rules](https://cursor.com/docs/rules).                                                                                                                                                                   |
| GitHub Copilot | [Repository instructions](../.github/copilot-instructions.md) reference AGENTS.md and the shared workflow. Some agents also read AGENTS.md directly.                                           | Check the active chat, agent, or review feature before relying on referenced files. [Instructions](https://docs.github.com/en/copilot/customizing-copilot/adding-custom-instructions-for-github-copilot). |
| Gemini CLI     | [GEMINI.md](../GEMINI.md) imports AGENTS.md. The workflow is linked from AGENTS.md, without a separate Gemini skill adapter.                                                                   | [Context and imports](https://geminicli.com/docs/cli/gemini-md/).                                                                                                                                         |

[Installed third-party skills](INSTALLED_SKILLS.md) use the skills CLI layout and relative Claude directory links.
That guide records Windows link requirements, pinned revisions, local adaptations, and security checks.
See [WRITING.md](WRITING.md) for English documentation rules based on ASD-STE100 Issue 9.

## Verify the active session

1. Start a new session in this repository.
2. Inspect loaded instructions and available skills.
3. Ask the agent to list instruction files without changing files.
4. Confirm Git limits, security review requirements, language rules, and terminal defaults.
5. Confirm that an available skill resolves to the shared workflow.

Claude provides `/context`. Gemini provides `/memory show`.
Host settings can disable instruction loading or skill discovery.
If automatic loading is unavailable, attach AGENTS.md and the shared skill explicitly.
Do not start another agent with repository write access only to test discovery.
Static checks do not prove that every vendor session follows instructions.

## Maintenance

- Change requirements in AGENTS.md and workflow instructions in the shared skill.
- Keep the Claude skill description consistent with the shared description.
- Keep adapters small. Check relative paths after directory changes.
- Read utility documentation before moving a utility rule to repository scope.
- Never add global permissions, automatic hooks, publication credentials, or network actions to adapters.
