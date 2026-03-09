---
name: gsd:sync
description: Sync .planning indexes with target branch so the merge is clean - no rebase needed
argument-hint: "[--dry-run] [--target=<branch>]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
---

<objective>
Prepare the current branch for a clean merge into a target branch (default: main) by resolving
.planning index collisions before they become merge conflicts.

Specifically:
1. Detect phase/quick index numbers that exist on both branches (collision)
2. Absorb phase entries from the target's ROADMAP.md that aren't in the local one (pre-empts ROADMAP.md merge conflicts)
3. Renumber branch-local phases and quicks to start after the target's highest index
4. Rename all affected directories and files to match

After running this, merging produces zero .planning conflicts.

> **This command is invoked precisely because the user suspects collisions may exist — including in
> archived phases. Do not assume the branches are clean. A collision can be:**
> - **An index conflict**: same number, different slug (e.g. `22-data-fields` vs `22-progressindicator-component`)
> - **A location conflict**: same full directory name appearing in different locations (e.g. active on one branch, archived on another)
>
> Treat every phase as potentially conflicting until the raw git data proves otherwise.
</objective>

<execution_context>
Arguments: $ARGUMENTS
- --dry-run: show all planned changes but make none
- --target=<branch>: base branch to sync against (default: main)
</execution_context>

<process>

## Step 1: Parse arguments and safety checks

Parse --dry-run and --target=<branch> from $ARGUMENTS. Default target to `main`.

Run `git branch --show-current` to get current branch name.
If current branch equals target branch: output error and stop.
  "Already on [target]. Switch to your feature branch first."

Run `git status --short` and note any uncommitted changes. If dirty, warn the user but continue.

## Step 2: Run the analysis script

Run this single command — it does all git reading and conflict detection for you:

```bash
node "$(git rev-parse --show-toplevel)/../get-shit-done/scripts/gsd-sync-analyze.cjs" --target=<target>
```

If the get-shit-done repo is installed elsewhere, adjust the path. If the script is not found,
fall back to Step 2b below.

Read the script output verbatim. It provides:
- **TARGET** section: active phases, archived phases, all phase nums, quicks
- **LOCAL** section: active phases, archived phases, quicks
- **BRANCH-LOCAL PHASES**: each with location (active/archived + version) and conflict status
- **BRANCH-LOCAL QUICKS**: each with conflict status
- **TARGET-ONLY PHASES**: phases on target not present locally (need ROADMAP absorption)
- **SUMMARY**: whether action is required

Also run:
```bash
git show <target>:.planning/ROADMAP.md
git show <target>:.planning/STATE.md
```

Extract from the script output (copy directly — do not reinterpret):
- **target_phases**, **target_archived_phase_dirs**, **target_all_phase_nums**, **target_max_phase**
- **target_quicks**, **target_max_quick**
- **local_phases**, **local_archived_phases** (with version)
- **branch_local_phases** (with location and conflict flag)
- **branch_local_quicks** (with conflict flag)
- **target_only_phases**

## Step 2b: Fallback (script not available)

If the script cannot be found, run these commands manually. Paste the **complete raw output** of
each into your working notes before doing any extraction — do not summarize or reconstruct from memory.

```bash
git ls-tree --name-only <target> -- .planning/phases/ | awk -F'/' '{print $NF}'
git ls-tree --name-only <target> -- .planning/quick/ | awk -F'/' '{print $NF}'
git ls-tree -r --name-only <target> -- .planning/milestones/ | awk -F'/' 'NF==5{print $4}' | sort -u
git ls-tree --name-only HEAD -- .planning/phases/ | awk -F'/' '{print $NF}'
git ls-tree --name-only HEAD -- .planning/quick/ | awk -F'/' '{print $NF}'
git ls-tree -r --name-only HEAD -- .planning/milestones/ | awk -F'/' 'NF==5{print $3, $4}' | sort -u
git show <target>:.planning/ROADMAP.md
git show <target>:.planning/STATE.md
```

Then extract manually — keeping full directory names (e.g. `22-data-fields`, never just `22`) at all times.

## Step 3: Read local ROADMAP and STATE

```bash
cat .planning/ROADMAP.md
cat .planning/STATE.md
```

## Step 4: Identify what needs to change

Read the script output (or your manual extraction) and identify:

**Branch-local phases** = listed in BRANCH-LOCAL PHASES section of script output (or: local dirs not
  present verbatim in target dirs). Note location: active or archived (+ version).

**Conflicting phases** = branch-local phases flagged CONFLICTS in script output (or: whose numeric
  prefix matches a number already used on target).

**Conflicting quicks** = branch-local quicks flagged CONFLICTS in script output.

**Target-only phases** = listed in TARGET-ONLY PHASES section of script output (or: target active
  phases not present verbatim locally). These need ROADMAP entries absorbed.

If there are no conflicting phases, no conflicting quicks, and no target-only phases:
  Output: "Nothing to sync — no index conflicts with [target]."
  Exit successfully.

## Step 5: Compute new indexes

For conflicting branch-local phases:
- Compute `all_retained_phase_numbers` = integer parts of all phase numbers from target_phases
  UNION integer parts of all non-conflicting branch-local phase numbers
- Compute `next_available = max(all_retained_phase_numbers) + 1` (or 1 if the set is empty)
- Sort conflicting phases by current phase number ascending (numerically, not lexicographically)
- Assign each conflicting phase the current `next_available`, then increment by 1
- Non-conflicting branch-local phases are left at their current number
- Example: target has 18, 20 — local has 18 (conflicting), 19 (non-conflicting), 20 (conflicting)
  → all_retained = {18, 20} ∪ {19} = {18, 19, 20} → next_available = 21
  → 18 → 21, 20 → 22. No collisions by construction.

For conflicting branch-local quicks:
- Same logic: `all_retained_quick_numbers` = target quick numbers ∪ non-conflicting local quick numbers
- `next_available = max(all_retained_quick_numbers) + 1`

Build a rename map: `{ old_name: new_name }` for both phases and quicks.

## Step 6: Present plan and confirm

Print the full plan before touching anything:

```
GSD Sync Plan
=============
Target branch : main
Current branch: feature/my-work
Max phase on main : 18
Max quick on main : 4

PHASES
  Absorb from main (ROADMAP only, no dir copy):
    Phase 18: feature-a  ← will be inserted into local ROADMAP.md

  Rename (directory + files inside):
    phases/18-feature-b/          → phases/19-feature-b/
      18-01-PLAN.md               → 19-01-PLAN.md
      18-01-SUMMARY.md            → 19-01-SUMMARY.md
      18-VERIFICATION.md          → 19-VERIFICATION.md

QUICKS
  Rename (directory + files inside):
    quick/4-fix-something/        → quick/5-fix-something/
      4-PLAN.md                   → 5-PLAN.md
      4-SUMMARY.md                → 5-SUMMARY.md

ROADMAP.md
  Insert  "### Phase 18: feature-a" section (absorbed from main)
  Rename  "### Phase 18: feature-b" → "### Phase 19: feature-b"

STATE.md
  Update phase number references 18 → 19
```

If --dry-run: print plan and stop. Do not touch anything.

Otherwise: ask user to confirm before proceeding.

## Step 7: Absorb target-only planning file content

**Do this before renaming** so all absorbed entries get the correct final numbers.

The goal is: after this step, the local branch already contains everything from the target branch
that it doesn't already have. Git will see those lines as already present → no conflict on them.
The merge will then only show lines that are genuinely new on the local branch.

### 7a: ROADMAP.md — phase sections

For each target-only phase (exists on target, not locally):
  - Extract the full phase section from target_roadmap. A phase section runs from its
    `### Phase N:` heading up to (but not including) the next `### Phase` heading.
  - Insert the extracted section into local ROADMAP.md at the correct sorted position
    (ordered by phase number, before any branch-local phases being renumbered).

### 7b: ROADMAP.md — milestone summary list

Read the `## Milestones` bullet list from both target and local ROADMAP.md.
For each `- ✅` or `- 🚧` line in target that does NOT appear verbatim in the local file:
  - Insert it into the local `## Milestones` list at the correct chronological position
    (ordered by version number, e.g. v1.7 before v1.8).

### 7c: MILESTONES.md

Read `.planning/MILESTONES.md` from both target (`git show <target>:.planning/MILESTONES.md`)
and local. For each `## v1.x` section in target that is NOT present in local (match on the
heading line, e.g. `## v1.7 Spell Word in Sentence`):
  - Extract the full section (from its `##` heading to the next `##` heading or end of file).
  - Insert it into the local MILESTONES.md at the correct chronological position (newer versions
    at the top, older below).

If MILESTONES.md does not exist on target, skip this step.

### 7d: PROJECT.md — capabilities list

Read `.planning/PROJECT.md` from both target (`git show <target>:.planning/PROJECT.md`) and local.

The capabilities list is the append-only bullet list of `- ✓ description — v1.x` lines that
records what each milestone shipped. Absorb any lines from target that are missing locally:

- Find all lines matching `- ✓ ` in target's PROJECT.md
- For each such line that does NOT appear verbatim in local PROJECT.md, insert it into the
  local capabilities list at the correct position (ordered by milestone version, e.g. v1.7
  items before v1.8 items)

Do NOT absorb target's "### Active", "## Current Milestone", or "Context" sections — these
reflect target's working state and should not overwrite the local branch's current state.

If PROJECT.md does not exist on target, skip this step.

### 7e: STATE.md

STATE.md reflects the current working state and should NOT be absorbed from target — the
local branch's version is always correct (it represents work done after the branch point).
Skip entirely.

If a merge conflict occurs in STATE.md after merging, resolve it by keeping the local
branch version of each conflicting block.

## Step 8: Rename phase directories and files

For each phase in the rename map (old → new):

Determine whether the phase is **active** or **archived**:
- Active: directory is in `.planning/phases/<old_name>/`
- Archived: directory is in `.planning/milestones/<version>-phases/<old_name>/`

The old file prefix is the full numeric part of the directory name followed by a hyphen
(e.g. directory `18-slug` → prefix `18-`, directory `18.1-slug` → prefix `18.1-`).
The new file prefix is the new integer phase number followed by a hyphen (e.g. `19-`).

**For active phases:**
1. Rename files inside the directory first. For each file in `.planning/phases/<old_name>/`
   whose name starts with the old file prefix:
   - Run: `git mv ".planning/phases/<old_name>/<old_file>" ".planning/phases/<old_name>/<new_file>"`
2. Rename the directory:
   - Run: `git mv ".planning/phases/<old_name>" ".planning/phases/<new_name>"`

**For archived phases** (in `.planning/milestones/<version>-phases/`):
1. Rename files inside the archive directory. For each file in
   `.planning/milestones/<version>-phases/<old_name>/` whose name starts with the old file prefix:
   - Run: `git mv ".planning/milestones/<version>-phases/<old_name>/<old_file>" ".../<new_file>"`
2. Rename the archive directory:
   - Run: `git mv ".planning/milestones/<version>-phases/<old_name>" ".planning/milestones/<version>-phases/<new_name>"`
3. Also update the milestone ROADMAP archive if it exists:
   - Read `.planning/milestones/<version>-ROADMAP.md`
   - Replace phase number references (headings, checkboxes, table rows) old → new
   - Write the updated file

Use `git mv` for all renames so git tracks them as renames rather than delete+add.

## Step 9: Rename quick directories and files

For each quick in the rename map (old → new):

1. Rename files inside first. List all files in `.planning/quick/<old_name>/`.
   The old file prefix is the old quick number followed by a hyphen (e.g. `4-`). The new file prefix is the new quick number followed by a hyphen (e.g. `5-`).
   For each file whose name starts with the old file prefix:
   - Compute the new filename by replacing the old prefix with the new prefix
   - Run: `git mv ".planning/quick/<old_name>/<old_file>" ".planning/quick/<old_name>/<new_file>"`

2. Rename the directory:
   - Run: `git mv ".planning/quick/<old_name>" ".planning/quick/<new_name>"`

## Step 10: Update ROADMAP.md

For each phase rename, update all references in local ROADMAP.md:
- Phase heading: `### Phase 18:` → `### Phase 19:`
- Checkbox entries: `**Phase 18:**` → `**Phase 19:**`
- Dependency references: `Depends on: Phase 18` → `Depends on: Phase 19`
- Table rows: `| 18.` → `| 19.` (be precise to avoid collateral changes)

Write the updated file.

## Step 11: Update STATE.md

Read `.planning/STATE.md`. For each phase rename:
- Update `**Current Phase:** 18` → `**Current Phase:** 19` (if applicable)
- Update phase references in progress tables

Write the updated file.

## Step 12: Report

Print what was done:

```
GSD Sync Complete
=================
✓ Absorbed 1 ROADMAP entry from main (Phase 18: feature-a)
✓ Renamed 1 phase: 18-feature-b → 19-feature-b (3 files)
✓ Renamed 1 quick: 4-fix-something → 5-fix-something (2 files)
✓ Updated ROADMAP.md
✓ Updated STATE.md

Ready to merge into main. No .planning conflicts expected.
Suggested next step: open your PR or run `git merge <this-branch>` from main.
```

Do NOT commit. Do NOT push. Leave that to the user.

</process>

<success_criteria>
- No branch-local phase or quick index overlaps with target branch after sync — including archived phases in `.planning/milestones/`
- Target branch's ROADMAP.md phase sections AND milestone summary list entries are absorbed into local ROADMAP.md
- Target branch's MILESTONES.md sections are absorbed into local MILESTONES.md
- Target branch's PROJECT.md `- ✓` capability lines are absorbed into local PROJECT.md
- All renamed directories (active and archived) have their internal files renamed to match
- Milestone archive ROADMAP files updated to reflect new phase numbers
- ROADMAP.md and STATE.md reflect the new numbers
- --dry-run shows the full plan with zero filesystem changes
- User confirmed before any changes were made (unless --dry-run)
- git mv used for all renames (preserves history)
</success_criteria>

<critical_rules>
- NEVER rename phases that exist on both branches — only branch-local ones
- NEVER copy phase directories from target — absorb ROADMAP entries only
- ALWAYS absorb target ROADMAP entries BEFORE renaming local phases (order matters for numbering)
- Use `git mv` for all renames, not plain `mv`
- Do NOT commit or push — leave staging and committing to the user
- Do NOT touch any files outside .planning/
- --dry-run must make ZERO filesystem changes
- If a branch-local phase has no numeric conflict with target, leave it at its current number
</critical_rules>
