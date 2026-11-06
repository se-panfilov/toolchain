# reRules

`tx-rerules` is an interactive CLI. It copies selected GitHub repository settings from a source repository to a target repository.

A typical use: you create a repository from a GitHub template. GitHub does not copy most settings of the template. reRules shows these settings, asks what to copy, shows a plan, and applies only the confirmed changes.

reRules does not compare all settings after the transfer. It is not a clone tool, a synchronization service, or an audit tool.
It does not create, delete, rename, or archive repositories. It does not change repository visibility.

## Prerequisites

- Node.js 24.12.0 or newer.
- macOS, Linux, or Windows. macOS is the primary platform. Windows was not tested on a real computer.
- An interactive terminal (TTY). Without a TTY, the program stops. CI and pipes cannot answer the questions.
- A target repository that exists on github.com. GitHub Enterprise Server is not supported.
- A GitHub token. See [Authentication](#authentication).

## Installation and start

After publication on npm:

```sh
npx tx-rerules --source my-user/my-template --target my-user/new-project
```

From this repository, run these commands from the repository root:

```sh
npm ci --ignore-scripts
npm run start --workspace tx-rerules -- --source my-user/my-template --target my-user/new-project
```

The start script builds `dist/` first. A build failure stops the start.

## Options

| Option          | Effect                                                                  |
| --------------- | ----------------------------------------------------------------------- |
| `--source REPO` | The source repository: `owner/repo` or `https://github.com/owner/repo`. |
| `--target REPO` | The target repository. It must exist.                                   |
| `--dry-run`     | Discovery, questions, and the plan. The target does not change.         |
| `--version`     | Show the version.                                                       |
| `--help`        | Show the help.                                                          |

If you do not give `--source` or `--target`, the program asks for them.

When you start the program in a local copy of a GitHub repository, the target question has a default value: that repository.
The program uses the `origin` remote. Without `origin`, it uses the only remote on github.com. You can edit or remove the value.
The program reads `.git/config` and does not start Git. If the local repository is the source, there is no default value.

## Authentication

The program looks for a token in this order:

1. The `GH_TOKEN` environment variable.
2. The `GITHUB_TOKEN` environment variable.
3. GitHub CLI: `gh auth token --hostname github.com`.
4. Hidden input in the terminal. The program shows instructions first.

The token stays in memory. The program does not write it to disk and does not show it.
The program checks the token with `GET /user`, then checks access to both repositories.
The program stops when the source is not readable, the target is archived, or the target has no write access.
Without administrator access to the target, most categories cannot change. The program shows a warning.

Use a fine-grained token for the two repositories only. Give the target only the write permissions of the categories that you transfer.

| Category                      | Source (read)            | Target (write)                         |
| ----------------------------- | ------------------------ | -------------------------------------- |
| Repository settings, topics   | Metadata                 | Administration                         |
| Environments                  | Actions, Environments    | Administration                         |
| Variables                     | Variables, Environments  | Variables, Environments                |
| Secrets                       | Secrets (names only)     | Secrets, Environments                  |
| Actions settings              | Administration           | Administration                         |
| Security settings             | Administration           | Administration                         |
| Access (collaborators, teams) | Administration           | Administration, Members (organization) |
| Labels and milestones         | Issues                   | Issues                                 |
| Autolinks                     | Administration           | Administration                         |
| Webhooks                      | Webhooks                 | Webhooks                               |
| GitHub Pages                  | Pages                    | Pages, Administration                  |
| CODEOWNERS                    | Contents                 | Contents                               |
| Rulesets                      | Metadata, Administration | Administration                         |
| Branch protection             | Administration           | Administration                         |

With a classic token, use `repo`, `read:org` for team checks, and `admin:repo_hook` for webhooks.
The table follows the GitHub REST API documentation. GitHub can change the requirements. A missing permission shows as "Недостаточно прав" or as a failed operation in the report.

## Interactive flow

1. The program shows the user, the source, and the target.
2. If the source is private and the target is public, the program asks for a confirmation.
3. For each category, the program reads the source and the target. It shows the values from the API responses.
4. The program asks whether to transfer the category: all, selected items, or skip. Complex categories also offer a JSON view.
5. For an existing target object, the program asks: keep, merge (where the merge has a clear meaning), replace, or skip.
6. The program shows the migration plan with the marks below.
7. You select "Применить изменения", "Показать план ещё раз", or "Отмена".
8. High-risk operations need one more confirmation. The default answer is "Нет".
9. The program applies the changes one by one and shows the progress and a report.

| Mark  | Meaning                                         |
| ----- | ----------------------------------------------- |
| `[+]` | Create an object in the target.                 |
| `[~]` | Update an object or a setting in the target.    |
| `[-]` | Skipped by the user.                            |
| `[=]` | Keep the target value. It can already be equal. |
| `[!]` | Cannot transfer. The line gives the reason.     |

A missing value has a state, not a default: "Не настроено", "Не поддерживается", "Недостаточно прав", "API недоступен", or "Неизвестно".
A missing source value never disables or deletes a target setting.
An incomplete target secret or variable inventory blocks that category's write plan.
This includes failed reads of the environment list or any environment scope.

Example of a session start:

```text
reRules — перенос настроек репозитория GitHub
Пользователь GitHub: my-user (GitHub CLI (gh auth token))

ИСТОЧНИК: my-user/my-template (public, личный)
ЦЕЛЬ:     my-user/new-project (private, личный)

────────────────────────────────────────────────
[1/15] НАСТРОЙКИ РЕПОЗИТОРИЯ
────────────────────────────────────────────────
```

Press Ctrl+C or Esc in a question to cancel. Nothing changes before the final confirmation.
Ctrl+C during the transfer stops the run after the current operation.

## Dry run

```sh
npx tx-rerules --source my-user/my-template --target my-user/new-project --dry-run
```

A dry run reads both repositories, asks all questions, and shows the plan. It does not ask for secret values.
The program blocks all write requests in this mode before it sends them.

## Categories and capability matrix

The categories run in this order. Environments come first, because variables, secrets, and rulesets refer to them.

| Category            | Read                                                                                                                                              | Write                                                                           | Not transferred                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Repository settings | `GET /repos/{o}/{r}`                                                                                                                              | `PATCH /repos/{o}/{r}`, `PUT .../topics`                                        | Name, owner, URL, visibility, template flag, archive state.                       |
| Environments        | `GET .../environments`, `.../deployment-branch-policies`, `.../deployment_protection_rules`                                                       | `PUT .../environments/{name}`, `POST .../deployment-branch-policies`            | Custom deployment protection rules of apps.                                       |
| Variables           | `GET .../actions/variables`, `.../environments/{name}/variables`                                                                                  | `POST`, `PATCH` of the same paths                                               | Organization variables.                                                           |
| Secrets             | `GET .../actions/secrets`, `.../environments/{name}/secrets` (names)                                                                              | `PUT .../secrets/{name}` with a new value, encrypted with the target public key | Secret values. GitHub never returns them. Organization and Dependabot secrets.    |
| Actions settings    | `GET .../actions/permissions`, `/selected-actions`, `/workflow`, `/access`                                                                        | `PUT` of the same paths                                                         | Workflow files. They come from the template.                                      |
| Security settings   | `security_and_analysis`, `/vulnerability-alerts`, `/automated-security-fixes`, `/private-vulnerability-reporting`, `/code-scanning/default-setup` | `PATCH /repos/{o}/{r}`, `PUT`/`DELETE` of the feature paths                     | Alerts, scan results, advisories.                                                 |
| Access              | `GET .../collaborators?affiliation=direct`, `.../invitations`, `.../teams`                                                                        | `PUT .../collaborators/{user}`, `PUT /orgs/{org}/teams/{slug}/repos/{o}/{r}`    | Organization membership, base permissions, owners. Teams of another organization. |
| Labels              | `GET .../labels`                                                                                                                                  | `POST .../labels`, `PATCH .../labels/{name}`                                    | Label assignments.                                                                |
| Milestones          | `GET .../milestones?state=all`                                                                                                                    | `POST .../milestones`, `PATCH .../milestones/{number}`                          | Issues of milestones.                                                             |
| Autolinks           | `GET .../autolinks`                                                                                                                               | `POST .../autolinks`                                                            | Changes of an existing autolink. GitHub has no update operation.                  |
| Webhooks            | `GET .../hooks`                                                                                                                                   | `POST .../hooks`, `PATCH .../hooks/{id}`                                        | Webhook secrets. You can enter a new secret. Hooks of other types than `web`.     |
| GitHub Pages        | `GET .../pages`                                                                                                                                   | `POST`, `PUT .../pages`                                                         | Custom domain. A domain can belong to one site only.                              |
| CODEOWNERS          | `GET .../contents/{path}` in the order `.github/`, root, `docs/`                                                                                  | `PUT .../contents/{path}` to the default branch                                 | The code owner review requirement. Set it in rulesets or branch protection.       |
| Rulesets            | `GET .../rulesets?includes_parents=true`, `GET .../rulesets/{id}`                                                                                 | `POST .../rulesets`, `PUT .../rulesets/{id}`                                    | Organization rulesets. They show as information.                                  |
| Branch protection   | `GET .../branches?protected=true`, `GET .../branches/{b}/protection`                                                                              | `PUT .../branches/{b}/protection`, `POST`/`DELETE .../required_signatures`      | Branches that do not exist in the target. Protection rules with name patterns.    |

Other settings that the program does not transfer: issues, pull requests, commits, releases, packages, projects, deploy keys, custom properties, interaction limits, the social preview image, and organization policies.

### Category details

- **Repository settings.** The program offers only values that differ. Paired commit title and message settings go together, because GitHub checks the pair. "Allow forking" applies only to organization repositories. The default branch changes only when the branch exists in the target. Topics do not change when the target topics are unknown.
- **Rulesets.** The program reads the full ruleset, not only the list item. It removes server data such as `id`, `source`, and dates. It removes bypass actors that cannot exist in the target: teams and organization roles in a personal or another organization repository, and apps of another owner. A removed bypass makes the ruleset stricter. A rule that refers to a missing environment or to a workflow file of the source repository is invalid. The program shows it and asks whether to copy the ruleset without it. The default answer is "Нет". An equal target ruleset is kept. A different one with the same name and target type is updated in place, not duplicated.
- **Branch protection.** The program shows each protected branch. For an existing target protection, "merge" keeps the stricter value of each selected field. A merge keeps an existing target app binding for a required status check. An unbound check can acquire the source app binding. Fields that you do not select keep the target value. A replace that weakens a field, including a removed or changed app binding, is a high-risk operation. Personal repositories cannot have push restrictions or review actor lists. Another organization gets empty actor lists, so only administrators can pass.
- **CODEOWNERS.** The program finds the file that GitHub uses. An equal file needs no write. A replace writes the exact bytes to the effective target path. The write includes the old file `sha`, so GitHub refuses the write if the file changed after discovery. The program checks owners: users must be collaborators, and teams must belong to the target organization and have access.
- **Actions.** An organization policy can override repository values. Then GitHub refuses the change with HTTP 409, and the report shows it.
- **Security.** The program enables features that are on in the source. It never treats an unavailable value as "off". To disable a feature that is on in the target, you must select it and confirm it again. Advanced Security, Code Security, and code scanning can cost money or Actions minutes. These are high-risk operations.
- **Environments.** The program checks each required reviewer in the target. If a reviewer or a protection rule cannot be reproduced, it asks before it creates a weaker environment. The default answer is "Нет". Existing branch policies of the target stay.
- **Webhooks.** Addresses show only the host, the first path segment, and a short hash, because many services put a token in the path. If a replacement removes a target webhook secret, the program asks a separate question. The default answer is "Нет".
- **Variables and secrets.** Variable values show in the terminal. An overwrite needs an answer. For secrets, the program shows names only. You can enter new values. Input is hidden. The program encrypts each value with the target public key (libsodium sealed box) and sends only the encrypted value.
- **Access.** Each new grant needs its own confirmation. Outside collaborators and users with unknown organization membership are never selected automatically. The confirmation question identifies unknown membership. An unreadable target team list blocks team changes. Matching custom roles stay unchanged. Changes between incomparable custom and standard roles are skipped with a warning. Personal repositories have one collaborator role with write access. The program never removes or lowers known access. GitHub sends an invitation to a new user.
- **Labels, milestones, autolinks.** The program creates missing objects. It updates an existing object only after a question. It never deletes.
- **Webhooks.** A new webhook sends target events to an external address. This is a high-risk operation. The display hides user data and query values of the address.
- **GitHub Pages.** A new site publishes repository content. This is a high-risk operation.

## GitHub plan and API limits

- Rulesets, branch protection, and environment protection rules on private repositories need a paid GitHub plan. The program shows "Не поддерживается" when GitHub refuses with a plan message.
- Security features depend on the plan and the repository type.
- GitHub returns some values, such as merge settings and `security_and_analysis`, only to administrators. Without them, the value shows as unknown and does not transfer.
- The program waits for rate limits up to five minutes and then stops with an error. It sends at most one change per second.

## Execution order and failures

The program applies changes in this order: repository settings, labels and milestones, environments, variables and secrets, Actions, security, access, webhooks and Pages, CODEOWNERS, the default branch, rulesets, branch protection.
Protection comes last, because a new rule can block a later file write.

- A failed operation does not stop independent operations.
- An authorization failure or a moved repository stops the remaining operations.
- The program does not roll back. It does not delete or reset settings because of a failure.
- A 5xx answer to a write is not repeated, because the change can be complete.
- The report shows each operation with its result and the error class: permission, validation, unsupported feature, conflict, or transient error.

## Rerun after a partial transfer

1. Read the report. Fix the cause of each failure, for example a missing permission.
2. Start the program again with the same `--source` and `--target`.
3. Settings that already transferred show as `[=]` and need no write.
4. Select only the remaining items.

The program matches objects by name: rulesets by name and target type, environments, variables, secrets, labels, and milestones by name, autolinks by prefix, and webhooks by address. A rerun updates these objects and does not make duplicates.
Before it creates a ruleset, the program reads the target rulesets again.

## Development

```sh
npm run typecheck --workspace tx-rerules
npm run build --workspace tx-rerules
npm test --workspace tx-rerules
npm run lint --workspace tx-rerules
```

Tests use a fake GitHub API. They do not need a token and do not change real repositories.

See [SECURITY.md](SECURITY.md) for the threat model, the controls, and the residual risks.
