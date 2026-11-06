# Toolchain writing rules

The reference is [ASD-STE100, Issue 9](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf), dated 2025-01-15.
Use its writing rules and dictionary for English documentation.
Do not claim full conformance from a sentence counter or an unchecked vocabulary list.

## Language

- Write documentation and code comments in English.
- Write the CLI interface and user-facing task reports in Russian.
- Keep commands, paths, identifiers, quoted software labels, and license text exact.
- Keep existing Russian test names and interface strings unless the task requires a change.

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
