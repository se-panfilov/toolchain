# moveToRepo security notes

This document describes the inputs, writes, subprocesses, and limits of moveToRepo.
It is a result of a static review and local tests. It is not a security certificate.

## Threat model

moveToRepo does not give the user new permissions. It uses the Git and `gh` authentication that the user already has.
The main risks are a push of incorrect data, a push to an incorrect target, and code execution through inputs or configuration.

| Protected item               | Risk                                                                 |
| ---------------------------- | -------------------------------------------------------------------- |
| Secrets on the local disk    | A key or a token goes into a repository. A push to GitHub is a leak. |
| Write access to repositories | An incorrect repository or branch gets the change.                   |
| Local files                  | Files go to a repository that another person controls.               |
| The target branch            | A direct push or a forced push changes history without a review.     |
| The local computer           | An argument or a repository setting starts a program.                |

## Inputs

| Input         | Source       | Control                                                                                                            |
| ------------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `--repo`      | Command line | Two strict patterns for github.com only. No user name, port, query, or other host. The clone URL is built again.   |
| `--base`      | Command line | ASCII letters, digits, `. _ / -`. No `..`, empty segments, segments that start with `.` or `-`, or `.lock`.        |
| `--dest`      | Command line | The same rules as file paths.                                                                                      |
| File paths    | Command line | Relative paths with Latin and Russian letters. No `..`, no dot segments, no control or mixed-script words.         |
| Current dir   | Process      | Its real path cannot have a segment that starts with a dot.                                                        |
| File contents | Local files  | Size limits. A known private key or token format stops the run.                                                    |
| Options       | Command line | Known names only. No repeats, no empty values, no values that start with `-`.                                      |
| `gh` JSON     | `gh` output  | Parsed without trust. The repository name must match. Write permission is required. The default branch is checked. |

File paths can contain Latin letters `A-Z a-z` and Russian Cyrillic letters `А-Я а-я Ё ё`. Other scripts are not permitted.
The owner decided to permit Cyrillic names. Before this decision, paths were ASCII only.

- A word is a sequence of letters without other characters. Each word must use one script.
  This rejects a Cyrillic letter that looks like a Latin letter inside a Latin word, for example `filе.txt` or `сredentials.json`.
- The rules apply to the NFC form of each segment. A decomposed `й` or `ё`, as some macOS programs write it, is accepted.
  The program opens the source file with the name as given. The repository path is always in the NFC form.
  Thus two forms of one name go to the same repository path, and the duplicate check stops the run.
- Combining marks that have no composed form, bidirectional control characters, and zero-width characters are rejected.

## Local files

- The current directory cannot be inside a directory that starts with a dot, such as `~/.docker`, `~/.kube`, or `~/.config/gh`.
  The check uses the real path. Such directories often keep secrets in formats that the content check does not find.
- Each path segment is checked with `lstat`. A symbolic link in any segment stops the run.
- Node.js has no `openat` or `fchdir`. The program uses the current directory as the directory handle.
  At the start, it records the device and inode of the directory where the process runs.
  Each step into this directory by its path, for each file and for the log, checks that identity again.
  The step back to the start directory is checked too. A rename of the root or of one of its parents,
  and a replacement by a link, give another identity, and the run stops.
- Below the root, the program goes into each directory with a relative name and compares the device and inode of `.` with the checked directory.
  A directory that another process replaces with a link after the check gives another inode, and the run stops.
  A rename of a parent after the step has no effect, because the next names are relative to the entered directory.
  The program restores the current directory at the end. The CLI is synchronous, so no other code sees the change.
- A file must be a regular file with one link. Hard links, directories, devices, and FIFOs stop the run.
- The file opens relative to the entered directory with `O_NOFOLLOW`. A link as the file name stops the run.
  The type, link count, and size checks use the opened descriptor, so they cannot go stale.
- The program reads the contents once. The same bytes go to the secret check and to Git.
- The program writes one local file: the operation log `__movetorepo-log.md` in the current directory. See [Operation log](#operation-log).
  Other writes go only to a private temporary directory, mode `0700`, which it removes at the end.

## Secret checks

- Names: all extensions of a name are checked, for example `terraform.tfstate.backup`. Extensions such as `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.ppk`, `.asc`, `.gpg`, `.kdbx`, `.env`, `.tfstate`, and names such as `id_rsa`, `credentials`, and `credentials.json`.
- All names that start with a dot, for example `.env`, `.npmrc`, `.netrc`, and `.git`.
- Contents: private key headers, tokens of GitHub, GitLab, AWS, Slack, npm, Stripe, JWT, and some API key formats.
  The text without NUL bytes is checked too, so UTF-16 text with Latin letters is checked.

These checks find typical cases only. A secret in another format is not found.
The user is responsible for the contents of the selected files.

## Subprocesses

- Git and `gh` start with argument arrays. No shell parses the arguments.
- The program finds Git and `gh` in fixed directories and in absolute `PATH` entries. It never uses the current directory.
- The environment has no `GIT_*` variables except `GIT_SSH`, `GIT_SSH_COMMAND`, and `GIT_SSH_VARIANT`.
  `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and `GIT_CONFIG_PARAMETERS` cannot change the target.
- The environment has no `GH_HOST`, `GH_REPO`, `GH_ENTERPRISE_TOKEN`, editor, browser, or pager variables.
  Variable names are compared without letter case.
- `gh` starts in the empty temporary directory, so a local repository cannot select the target. Each call has `--repo` or an explicit `OWNER/REPO`.
- Git gets settings with priority over the user configuration:
  - `core.hooksPath` points to an empty directory. No hook starts, including global hooks.
  - `core.fsmonitor=false`. No fsmonitor program starts.
  - `protocol.allow=never` with only `https` and `ssh` permitted. `file`, `ext`, and other transports are blocked, also through URL rewrite rules.
  - The credential helper list is cleared. Then `gh auth git-credential` gives the token of the signed-in user.
  - No submodules and no tags on push. No automatic maintenance.
- `--` separates options from the URL and paths in `clone`, `ls-remote`, `ls-tree`, and `push`.
- `GIT_LITERAL_PATHSPECS=1` makes Git read paths as literal names.

## Repository writes

- The clone has no work tree (`--no-checkout`). Repository files never go to the disk, so links in the repository cannot redirect writes.
  No checkout filter starts.
- Files go into the Git index with `hash-object --no-filters` and `update-index`. The commit is made with `commit-tree`, which starts no hooks.
- A destination that is a directory, a symbolic link, or a submodule in the repository stops the run. A parent that is not a directory stops the run.
- After the commit, the program compares the changed paths with the list. Another change stops the run before the push.
- The push sends `<commit>:refs/heads/movetorepo/<random>`. There is no `--force`, no `--force-with-lease`, and no `+` refspec.
  The program first checks that the branch does not exist on the server.
- The target branch is changed only when a person merges the pull request.

## No merge by the program

- The program opens a pull request and stops. It never merges, approves, or enables automatic merge.
- `gh` can start only three commands: `repo view` with `--json`, `api user` without other arguments,
  and `pr create` with only `--repo`, `--base`, `--head`, `--title`, and `--body-file`. Other commands and options stop the run before `gh` starts.
- `git push` accepts only a branch name `movetorepo/<8 hex digits>`, so the push cannot change the target branch.
- A test checks that the source and the build contain no merge, approval, or automatic merge command.
- Settings and workflows in the target repository are outside the program. For example, a GitHub Actions workflow
  in the repository can merge pull requests. The program does not check or change such workflows.
- The program does not require a review. The pull request author is the repository owner, and GitHub does not let
  an author approve their own pull request. A required review would block the owner's own pull requests,
  and a change of branch protection is a change of repository settings that the program does not make.

## Repository owner

- The program reads the signed-in user with `gh api user` and the repository with `gh repo view`.
- The repository owner must be the same login, without letter case. Organization repositories and repositories of other users stop the run,
  also when the user has write access. This prevents a transfer of local files to a repository that another person controls.
- The check runs before the clone and also in a dry-run. The push uses the same `gh` account through `gh auth git-credential`.
- The check does not read visibility. The owner decided to permit public repositories of the account.
  Anyone can read a public repository, so a push there publishes the files at once, before any merge.
- The check does not read collaborators. People that the owner invited to a private repository can read the pushed branch.
- A user can still transfer the repository to another owner, make it public, or add collaborators later. The check applies only at the time of the run.
- The account is the active `gh` account. `GH_TOKEN`, `GITHUB_TOKEN`, and `GH_CONFIG_DIR` in the environment can select another account.
  A person who controls both the arguments and the environment of a run can select their own account and its repository.
  The program does not pin one approved account. A person with this control can also read the files and send them with other tools.

## Operation log

- Path: `__movetorepo-log.md` in the current directory. A source file with this name is rejected.
- The log is checked and opened relative to the start directory, after its identity check. A replaced root or parent stops the run.
- Before network access, the program checks the path with `lstat`: a missing file, or a regular file of the current user with one link.
- Before the push, the file opens with `O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW`, mode `0600` for a new file.
  The type, link count, and owner checks use the opened descriptor. A link, also a dangling link, stops the run before the push.
  An existing file with access for the group or others is changed to `0600`.
- Each part of an entry is one append write, followed by `fsync`. The file is never truncated or replaced.
- Each entry has a random operation ID. The result line has the same ID, so results of parallel runs match their entries.
- Paths and error text are in Markdown inline code with a safe fence. Control characters are replaced.
  Known token formats and credentials in URLs and `Authorization` headers are hidden in error text. Other secret formats are not detected.
- The log contains local paths and repository names, which can be private metadata. It contains no file contents.

## Trust assumptions

- The user trusts their own Git and `gh` configuration. URL rewrite rules, the SSH command, commit signing, and the user identity come from it.
- The user trusts the installed Git and `gh` programs and the npm package.
  A changed package can use the user's write access to all repositories. Run a fixed version, for example `npx tx-movetorepo@0.3.1`.
- GitHub and `gh` give correct repository data.

## Residual risks

- Secrets in an unknown format are not found.
- The owner check trusts the user's Git configuration. A URL rewrite rule in it can send the push to another address.
- A process of the same user can change or delete the log. The log is a record for the user, not a tamper-proof audit trail.
- `--no-filters` stores files as they are. In a repository that keeps some files in Git LFS, a file for an LFS path goes in as a regular file.
- Two directories with names that are different only in letter case can occur in the repository, for example `Docs` and `docs`.
- A Ctrl+C during the push or the pull request step can leave a branch without a pull request. See the recovery section in the README.
- Ctrl+C, `SIGTERM`, and `SIGHUP` remove the temporary directory. `SIGKILL` or a power loss can leave the clone in the temporary directory, mode `0700`.
- The branch check and the push are two operations. If a user with write access creates the same branch between them,
  on the base commit or on an ancestor of the new commit, a push without force moves that branch forward. History is not lost,
  and the target branch does not change. The random part of the name has 32 bits, and the time window is short.
  The owner accepted this risk instead of a `--force-with-lease` push that only creates a branch.
- A word made only of Cyrillic letters can look like a Latin word, for example `рае` and `pae`.
  The mixed-script rule does not find such words. The pull request shows the real names. The secret name check uses Latin names only.
- The current directory check helps only when the directory name starts with a dot. Other directories with secrets are not detected.
- Automatic tests use synthetic local repositories. A manual run used a local repository and a fake `gh`.
  Real pushes to GitHub and real `gh` calls were not tested.
