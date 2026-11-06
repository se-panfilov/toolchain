# repoRules security notes

This document describes the inputs, writes, external effects, and limits of repoRules.
It is a result of a static review and local tests with a fake GitHub API. It is not a security certificate.
The program was not tested against real GitHub repositories, on Windows, or on macOS.

## Threat model

repoRules does not give the user new permissions. It uses a GitHub token that the user already has.
The main risks are a change of an incorrect repository, a weaker protection in the target, an unwanted access grant, a leak of a token or a secret value, and terminal output that misleads the user.

| Protected item              | Risk                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------- |
| The source repository       | A write to the source. The program must only read it.                                   |
| Other repositories          | A write to a repository that the user did not select as the target.                     |
| Target protections          | A replace makes rulesets, branch protection, environments, or security features weaker. |
| Repository access           | A new collaborator, a team grant, or a webhook sends data to another person.            |
| The token and secret values | Output, logs, files, or error text show them.                                           |
| Private source data         | A public target shows private descriptions, labels, environments, or CODEOWNERS.        |
| The terminal                | Repository data with control characters changes the display.                            |

## Inputs

| Input                  | Source                    | Control                                                                                                                             |
| ---------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `--source`, `--target` | Command line or prompt    | `owner/repo`, `https://github.com/owner/repo`, or `git@github.com:owner/repo`. Other hosts, ports, queries, and paths stop the run. |
| Options                | Command line              | Known names only. No repeats, no empty values, no values that start with `-`.                                                       |
| Token                  | Environment, `gh`, prompt | Printable ASCII without spaces, 20–255 characters. Checked with `GET /user`.                                                        |
| API responses          | GitHub                    | Treated as untrusted data. Types are checked before use. A missing value gets a state, never a default.                             |
| Repository contents    | CODEOWNERS                | Read as data. Only a regular file up to 1 MB. The program never runs or follows text from repositories.                             |
| Answers                | Terminal                  | Arrows and Space. Digits and letters do not confirm. Bracketed paste cannot select or confirm an answer.                            |
| Secret values          | Hidden prompt             | Not shown, not logged, not written to files. Up to 48 KB.                                                                           |

## Controls

### Writes go only to the target

- The API client refuses every write before the final confirmation. In dry-run mode, it refuses every write for the whole run.
- After the confirmation, the client accepts writes only for `/repos/{target-owner}/{target-repo}` and its subpaths, and for `PUT /orgs/{target-owner}/teams/{slug}/repos/{target-owner}/{target-repo}`. A write to any other path stops before the request.
- Each path segment is URL-encoded. Names from API responses cannot add path segments or a query.
- The program checks that GitHub returned the requested repository. A renamed or moved repository stops the run. The client does not follow redirects.
- Source and target cannot be the same repository. The program compares the repository ID and the name without letter case.

### The token

- The API address is fixed to `https://api.github.com`. Environment variables such as `GH_HOST` cannot change it.
- The token goes only in the `Authorization` header. Pagination links to another origin stop the run, so the token cannot go to another host.
- `gh auth token` runs with an argument array, without a shell, with a 15 second timeout. Its environment has no `GH_HOST`, enterprise tokens, debug variables, or pager. The program searches `gh` only in absolute `PATH` entries.
- The token is not saved, not shown, and not included in error messages.

### Weaker protections and high-risk operations

- A missing or unavailable source value never disables or deletes a target setting.
- Branch protection "merge" keeps the stricter value. Fields that you do not select keep the target value. The program lists each weakened field.
- An invalid ruleset rule or an unreproducible environment rule needs a separate answer. The default is "Нет".
- Bypass actors that cannot exist in the target are removed. A removed bypass makes the rule stricter.
- To disable a security feature, you must select it and confirm it again.
- These operations need one more confirmation after the plan, with the default "Нет": weaker branch protection, replaced rulesets and environments, disabled security features, paid security features, access grants, new or replaced webhooks, new Pages sites, Actions permission changes, CODEOWNERS writes, overwritten variables and secrets, and a default branch change.
- Each access grant needs its own confirmation. Outside collaborators are not selected automatically.
- If the source is private and the target is public, the program asks before discovery. The default is "Нет".

### Secrets

- GitHub never returns secret values. The program does not claim to copy them.
- A new value is encrypted on the local computer with the target public key (libsodium sealed box). Only the encrypted value goes to GitHub.
- The value stays in memory until the write. The program then drops its reference. JavaScript cannot erase string memory, so a copy can stay in memory until the process ends.
- Webhook secrets follow the same rules. The display of webhook addresses hides user data and query values.

### Terminal output

- All text from GitHub goes through a filter that replaces control and format characters, including bidirectional controls, before colors are added.
- Colors stop when `NO_COLOR` is set, when `TERM=dumb`, or when the output is not a terminal.
- Prompts restore the raw mode and remove their handlers after success, cancellation, and errors.

### Non-interactive runs

- Without a TTY on standard input and output, the program stops before authentication. There is no option to skip questions.

### Concurrent changes and reruns

- Before it creates a ruleset, the program reads the target rulesets again and stops this item if a ruleset with the same name appeared.
- A CODEOWNERS replace sends the old file `sha`. GitHub refuses the write if the file changed.
- Other objects are matched by name. A rerun updates them and does not create duplicates.
- A 5xx answer to a write is not repeated. Reads are repeated up to three times.

## Dependencies

| Package              | Reason                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `libsodium-wrappers` | Sealed box encryption for GitHub secrets. Node.js has no XSalsa20-Poly1305 implementation. |

The package and its dependency `libsodium` have no installation scripts. The version is exact in the lockfile.
HTTP requests use the Node.js `fetch` function. Prompts use the Node.js `readline` module.

## Residual risks

- GitHub can change the API, the permission model, or plan limits. Unknown answers show as errors or unknown states.
- The program cannot check that an app in a ruleset bypass list or a status check is installed in the target. It shows a warning. GitHub refuses an invalid app.
- The program cannot fully check e-mail owners in CODEOWNERS.
- The response size check runs after the body is read. A very large response can use memory up to the limit.
- Variable values show in the terminal, as the task requires. Do not run the program while another person can see the screen.
- The token has the permissions that the user gave it. Use a fine-grained token for the two repositories.
- A CODEOWNERS write is a direct commit to the default branch of the target. Rules of the target can refuse it.
- Windows and macOS behavior was not tested on real computers.
