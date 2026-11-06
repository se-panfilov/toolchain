# Toolchain writing rules

The reference is [ASD-STE100, Issue 9](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf), dated 2025-01-15.
Use its writing rules and dictionary for English documentation.
Do not claim full conformance from a sentence counter or an unchecked vocabulary list.

## Language

- Write documentation and code comments in English.
- Write the CLI interface and user-facing task reports in Russian.
- Keep commands, paths, identifiers, quoted software labels, and license text exact.
- Write test names, test data, and test comments in English. Tests are not user interaction.
- Use Russian in tests only to match Russian interface strings, such as an expected error message.
- ESLint rejects Cyrillic in test names and code comments. See [ESLint rules](ESLINT.md).

## External examples

Do not name or link to applications used as examples.
This rule applies to repository files, commit messages, pull requests, issues, and review comments.
Describe the relevant behavior or technique without naming the example application.

## Procedures and descriptions

1. Use one consistent technical term for each concept.
2. Use dictionary words with their approved meanings and parts of speech.
3. Define necessary technical terms in the relevant utility documentation.
4. Put one instruction in each procedure sentence.
5. Use the imperative and active voice for procedures.
6. Put necessary conditions before the related instruction.
7. Limit procedure sentences to 20 words.
8. Limit descriptive sentences to 25 words.
9. Limit paragraphs to six sentences.
10. Do not use semicolons in prose.
11. Put data loss cautions before the related actions.
12. Keep instructions consistent with the actual defaults, prompts, and failure behavior.

Use tables for comparisons and mappings.
Explain preconditions, expected results, cancellation, and recovery when the operation needs them.
Distinguish a verified result from a recommendation or an untested assumption.

The [reHistory terminology](../apps/reHistory/TERMINOLOGY.md) contains terms for that utility.
It does not define requirements for unrelated utilities.

## Commits and pull requests

Write commit messages and pull request text in English.
Apply ASD-STE100 Issue 9 to commit subjects and bodies.
Apply the same standard to pull request titles and all description text after `tl;dr`.
Use the writing rules and dictionary for these texts.
Keep commands, paths, identifiers, and quoted software labels exact.

Start every pull request description with the heading `## tl;dr`.
Explain the problem and the result in plain language for a reader with little subject knowledge.
Avoid unexplained technical terms in this section.
Keep this section as short as possible, with one or two paragraphs.
The `tl;dr` section uses these plain-language requirements. The rest of the pull request must follow ASD-STE100.

Never add links to AI agent threads, chats, or sessions where a feature was discussed.
The commit-msg hook and the `pr-rules` CI job reject known links of this type. See [Enforced rules](ENFORCED_RULES.md).
This rule applies to repository files, commit messages, pull requests, issues, and review comments.
Do not add commit trailers or attribution lines with such links.
These links are often private, and they can expire. Write the necessary context in the text itself.

Use the [pull request template](../.github/pull_request_template.md).
Replace its instructions with the task details.
Describe the final change and the completed checks.
Identify checks that were not run and any remaining limits.
