# Documentation rules and technical terms

## Reference and scope

The writing reference is [ASD-STE100, Issue 9](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf).
The issue date is 2025-01-15.
The standard has writing rules and a dictionary.

English prose in this project uses the writing rules and the project terms below.
Code comments use English.
The user interface uses Russian.
Do not change Russian interface strings, test names, or displayed software labels.
Commands, identifiers, file paths, and quoted labels keep their exact spelling.
Do not change the software license text.

Another person has not done an STE language check.
A sentence count or word list alone does not show conformance to all rules.

## Author procedure

1. Use consistent technical terms.
2. Use dictionary words with their approved meanings and parts of speech.
3. Write one instruction in each procedure sentence.
4. Use the imperative and active voice for procedures.
5. Put necessary conditions before instructions.
6. Limit procedure sentences to 20 words.
7. Limit descriptive sentences to 25 words.
8. Limit paragraphs to six sentences.
9. Do not use semicolons in prose.
10. Put data loss cautions before the related actions.

Refer to rules 1.1 to 1.14, 3.6, 5.1 to 5.5, 6.3 to 6.6, 7, and 8.

## Project technical nouns

Use these nouns for software concepts.
Do not use a noun as a verb unless the technical verb table gives that use.
The table does not change the approved general meanings in the STE dictionary.

| Technical noun | Meaning in this project |
| --- | --- |
| address | A network location or email destination. |
| ANSI terminal | A terminal that can display the program control sequences and colors. |
| answer | A value or choice entered at a terminal question. |
| application | Software that does a user task. |
| binary data | File contents represented as bytes. |
| byte | A software storage unit of eight bits. |
| cancellation | A user action that stops an input question before a write operation. |
| command | An instruction that starts a software operation. |
| common Git directory | The Git directory shared by worktrees. |
| config entry | A name and value in Git config. |
| control sequence | Terminal characters that change display or input behavior. |
| current branch | The local branch selected by HEAD. |
| current directory | The directory selected when the command starts. |
| default | The initial value of a software field or choice. |
| dependency | A package necessary for software operation. |
| destination | The path or server location selected for software output. |
| dry-run | An operation that gives a plan without writes. |
| line | One row of software text or a terminal input field. |
| submodule | A repository identified by a gitlink in another repository. |
| directory | A file system entry that groups other entries. |
| documentation | The text that gives software procedures and descriptions. |
| email address | An address used in commit and tagger identity fields. |
| event handler | Code that operates after a specified software event. |
| field | A named value in software data. |
| format | The structure of software data or text. |
| graph | The object links that connect Git commits. |
| history | The commits and parent links selected from a Git repository. |
| hosting service | A service that stores remote Git repositories. |
| identifier | A value that identifies a software object or process. |
| interactive question | A terminal question with a field for a user answer. |
| language check | An examination of words, meanings, and writing rules. |
| lifecycle | The sequence of package events controlled by npm. |
| local time | A time in the system time zone. |
| machine report | Software output intended for another program. |
| memory | The storage that a process uses during operation. |
| message | The text section of a commit or annotated tag. |
| network | The software connections to other systems. |
| option | A command argument that selects software behavior. |
| permission | An affirmative user choice before a software write. |
| plan | The selected refs, new objects, and date policy before a write. |
| platform | The operating system and runtime used for the program. |
| prefix | The first part of a generated software name. |
| program | The executable software described in these documents. |
| project | The source files and documentation of this software. |
| publication | The operation that makes an npm package available through a registry. |
| question | A prompt that accepts software input. |
| reachability | The presence of a path through Git object links. |
| reachable object | An object that a Git ref can reach through object links. |
| registry | The service that stores published npm packages. |
| request | A software message sent to a network service. |
| response | The software data given after a request. |
| security | Software controls against unwanted access, data loss, or data changes. |
| software | Program instructions and their data. |
| state | The values of software data at a specified point. |
| stream | A software input or output channel. |
| temporary directory | A directory used for files with a limited lifetime. |
| test | A procedure that compares software behavior with specified results. |
| text | A sequence of characters in software data or documentation. |
| time zone | The system rules for local time and offsets. |
| type check | An examination of TypeScript type rules without program execution. |
| user | The person who starts the program or enters its input. |
| writing rule | A rule that controls document words, grammar, or structure. |
| allowlist | The exact set of permitted names or values. |
| alternates | Git data that refers to an external object store. |
| ancestor | A commit reachable through parent links from another commit. |
| annotated tag | A tag object with a name, message, and tagger fields. |
| API | A software interface that another program can use. |
| archive | A package file that contains other files. |
| argument array | Different command arguments given to a child process. |
| atomic push | A server operation that changes all selected refs or none. |
| audit | A report about refs, object data, and local metadata. |
| authentication | The process that establishes a user identity for access. |
| author | The identity in the author header of a commit. |
| author date | The timestamp in the author header of a commit. |
| backup | A different copy or reference kept for recovery. |
| backup branch | A local branch that keeps the initial branch tip. |
| backup ref | A ref that keeps an initial object reachable. |
| bare repository | A Git repository without a working tree. |
| bin | An npm entry that starts the package command. |
| bisect | A Git operation that locates a change through selected revisions. |
| blob | A Git object that contains file contents. |
| bracketed paste | A terminal protocol that identifies pasted input. |
| branch | A named Git ref that identifies a commit. |
| branch tip | The commit that a branch identifies. |
| build | JavaScript files made from the TypeScript source. |
| checkbox | A terminal control that shows a selected or unselected answer. |
| checkout | A Git operation that writes a working tree or changes its selected branch. |
| cherry-pick | A Git operation that applies a selected commit to the current branch. |
| child process | A process that another process starts. |
| CLI | The command-line interface. |
| clone | A repository copy made by Git. |
| commit | A Git object that contains tree, parent, identity, date, and message data. |
| committer | The identity in the committer header of a commit. |
| committer date | The timestamp in the committer header of a commit. |
| config | Git config data. |
| control character | A character that controls terminal behavior rather than text display. |
| counter | A number that increases between generated names. |
| credential | Data used for authentication. |
| credential helper | A program that supplies Git credentials. |
| demo | The sequence that makes test history and sends it to a specified server. |
| detached HEAD | A HEAD value that does not select a local branch. |
| digital signature | Cryptographic data used to authenticate an object. |
| engine | The code that prepares and applies a history plan. |
| environment variable | A named value available to a process. |
| executable | A program file that the operating system can start. |
| export | The export repository that contains only selected history. |
| export check | A comparison of the export with its manifest and date policy. |
| file mode | The access bits that a POSIX file system assigns to a file. |
| file system | The operating system structure that stores files and directories. |
| focus | The answer position controlled by the terminal arrow keys. |
| fragment | The part of a URL after the number sign. |
| fsmonitor | The Git file system monitor. |
| garbage collection | The Git process that can remove objects no longer protected by refs or reflogs. |
| Git | The version control program. |
| Git routing | The selection of a repository, index, or working tree through environment variables. |
| gitlink | A tree entry that identifies a submodule commit. |
| graft | Local data that substitutes parent links during a Git traversal. |
| hard link | A second file name for the same stored file data. |
| hash | The algorithm output used as an object ID. |
| header | An object field before the message. |
| HEAD | The Git name that selects the current branch or commit. |
| hidden ref | A ref not in the ordinary branch and tag namespaces. |
| hook | A program that Git can start at a defined event. |
| host key | The public key that identifies an SSH server. |
| identity | A name and email address stored in an object. |
| index | The Git data that records files selected for the next commit. |
| input | Data given to the program. |
| inventory | The complete list of available objects or refs. |
| JSON | The data format used for machine reports and recovery files. |
| lazy fetch | An automatic network request for a missing Git object. |
| lifecycle script | A script that npm starts at a package event. |
| lightweight tag | A tag ref without a different annotated tag object. |
| local branch | A branch in the source repository. |
| lock file | A file that prevents a second operation of the same type. |
| manifest | The export file that records new refs, object IDs, and policy. |
| merge | A Git operation or commit that combines histories. |
| metadata | Object fields that are not file contents. |
| namespace | A shared prefix that groups ref names. |
| nested tag | An annotated tag whose target is another annotated tag. |
| npm | The Node.js package tool. |
| npx | The npm command that starts a package bin. |
| object | A commit, tag, tree, or blob stored by Git. |
| object ID | The hash that identifies a Git object. |
| object store | The files and packs that contain Git objects. |
| offset | The signed time difference from UTC. |
| output | Data that the program gives to the user or another process. |
| package | The files and metadata distributed as one npm unit. |
| parent | A commit named by a parent link in another commit. |
| parent link | An object ID in a commit parent header. |
| partial clone | A repository that can require objects from a remote server. |
| PATH | The environment variable that selects executable search directories. |
| PID | The operating system identifier of a process. |
| pipe | A software channel between program input and output. |
| placeholder | Example text that the user must replace with an correct value. |
| policy | The selected rules for replacement dates and identities. |
| POSIX | The family of operating system interfaces used for file mode descriptions. |
| promisor | Git config for a repository that does not have all objects locally. |
| protocol | The rules used for a data exchange. |
| PTY | A terminal interface used for automatic interactive tests. |
| query string | The part of a URL that contains query parameters. |
| raw mode | A terminal state that gives individual keys directly to the program. |
| rebase | A Git operation that makes new commits on another base. |
| recovery transaction | A ref transaction that restores initial ref values. |
| recovery file | The JSON file with initial and specified new refs. |
| ref | A Git reference that identifies an object or another ref. |
| ref transaction | A group of ref operations with old value comparisons. |
| reflog | A local record of earlier ref values and operation times. |
| refspec | The source and destination ref names used for a server transfer. |
| remote | A Git server location or its local config entry. |
| remote helper | A program that implements a Git transport. |
| remote-tracking ref | A local ref that records a remote branch state. |
| repository | A Git object store, refs, and related config. |
| revert | A Git operation that makes a commit to reverse another change. |
| runtime | The environment in which a program operates. |
| script | Program instructions in a text file. |
| sequencer | Git state used for a sequence of commit operations. |
| server | The remote system that accepts demo data. |
| service ref | A ref kept by a tool such as Codex. |
| SHA-1 | A hash format for Git objects. |
| SHA-256 | A hash format for Git objects. |
| shallow clone | A repository with a boundary that omits earlier commits. |
| shell | A command interpreter. |
| signature block | The section that contains an object signature. |
| snapshot | A saved state used for comparison. |
| source repository | The repository selected by the user before an export. |
| SSH | The secure transport protocol used by the demo. |
| stash | Git refs and objects that keep temporary working tree changes. |
| symbolic link | A file system entry that refers to another path. |
| symbolic ref | A Git ref that contains another ref name. |
| tag | A named Git reference, with an optional annotated tag object. |
| tagger | The identity that made an annotated tag. |
| tagger date | The timestamp in an annotated tag header. |
| target | The object identified by a ref or tag. |
| terminal | The interactive input and output device used by the CLI. |
| timestamp | An integer count of seconds with a time zone offset. |
| TLS | The transport security protocol used for HTTPS. |
| token | Authentication data that can grant access to a service. |
| topology | The commit graph defined by parent links. |
| transaction preparation | The Git step that compares and locks refs before a transaction. |
| transport | The Git process that transfers data between repositories. |
| transport adapter | The code that supplies server operations to the demo. |
| tree | A Git object that records names, file modes, and child object IDs. |
| TTY | A terminal input or output stream. |
| TypeScript | The source language of this program. |
| untracked file | A working tree file absent from the Git index. |
| unreachable object | An object that no selected ref can reach. |
| URL | The address of a network resource. |
| UTC | The reference time scale for date offsets. |
| UUID v4 | A random identifier whose format does not encode time. |
| validator | Code that rejects values not in a permitted format or range. |
| working tree | The files selected from a Git repository for local work. |
| worktree | A Git checkout attached to a shared repository. |

Product names, command names, options, API names, and identifiers keep their official spelling.
Examples include `Node.js`, `fsync`, `readline`, `GIT_*`, and `NO_COLOR`.

## Project technical verbs

Use these verbs only for their stated software actions.
Use dictionary verbs for other meanings.
Rule 1.12 gives categories for technical verbs in computer processes and applications.

| Technical verb | Permitted software action |
| --- | --- |
| apply | Write the changes from a commit into another Git history. |
| edit | Change text in an input field or software file. |
| enter | Put a value into a software input field. |
| advertise | Make a ref visible in a Git server response. |
| authenticate | Establish an identity through credentials or a digital signature. |
| copy | Write a different instance of software data without a shared file link. |
| disable | Make a software function unavailable. |
| encode | Represent a value in a software data format. |
| export | Write the selected history to an export repository. |
| generate | Create software test data or an identifier. |
| identify | Select an object through its software identifier. |
| insert | Put data at a specified position in a file or input field. |
| publish | Make a package or repository available external to the local project. |
| redirect | Send a network request to another URL. |
| reject | Stop an operation because its input or state fails a software rule. |
| reset | Change a Git branch, index, or working tree through the Git reset operation. |
| restore | Make saved software data active again. |
| sanitize | Remove software control characters from displayed input. |
| synchronize | Make file data persistent through the fsync operation. |
| validate | Compare input with software format and range requirements. |
| verify | Compare object IDs, signatures, or stored software state with specified values. |

## Documentation check

1. Make sure that Russian interface strings keep their initial contents.
2. Make sure that all command examples use available options.
3. Make sure that every local document link has a target.
4. Make sure that the package includes all documents linked from its README.

Use mechanical checks to find possible language errors.
A full dictionary and meaning check is also necessary.
