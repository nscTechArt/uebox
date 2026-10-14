---
name: replace-with-skill-name
description: Performs replace-with-the-observable-outcome. Use when the user asks for replace-with-natural-language-triggers. Do not use for replace-with-neighbouring-work-or-unsupported-actions.
---

# Replace with skill title

## Outcome

State the observable result this workflow delivers.

## Workflow

1. Read the authoritative source of truth.
2. Choose the narrowest valid path from the real inputs. When several approaches work, try the
   cheap, reversible one first (read-only query → runtime toggle → setting or instance → a
   destructive step on a copy → the original).
3. Before deleting, renaming or changing a signature, find what references it.
4. Perform only the actions required by the request.
5. Verify in the state where the result actually takes effect (re-run PIE, read the asset back,
   open the rendered frame), not by the tool's success message. Name what only the user can
   verify (feel, multiplayer) and ask them to.
6. State which number the conclusion rests on and what it really measures.

## Coverage

- Verified: state the one real case this was distilled from, including the conditions that
  would change the answer (asset shape, material type, engine version).
- Not tried: name the neighbouring cases this workflow has not been run against.

A skill distilled from one run has a sample size of one. Saying so is not a weakness — it tells
the next run where the map ends. Move a case from "not tried" to "verified" once it is actually run.

## Constraints

- Preserve the user's explicit choices and existing work.
- Do not guess missing identifiers, paths, credentials, or external state.
- Do not expand the task into unrelated mutation, deletion, publishing, or deployment.

## Failure handling

- Ask only when missing information would materially change the result.
- Stop instead of silently changing targets or weakening validation.
- Report partial state and the safest recovery step.

## Output

Report what is complete, how the user can verify it, and any remaining gap.
