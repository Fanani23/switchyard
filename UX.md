# Switchyard — Interaction Design

Stage 3 of the universal development pipeline. Every view enumerates five states, every
input that triggers a network call declares its debounce or cancellation rule, and every
mutation declares its rollback. No screen reaches implementation without all three.

## The governing idea

**A flag toggle is a production deployment.**

It changes behavior for real users in under a second, with no review, no build and no
rollback pipeline. The interface has to carry that weight without becoming tedious for the
dozens of harmless toggles a developer makes in staging.

The resolution is that friction scales with blast radius, not with the action:

| Environment | Rollout | Interaction |
| --- | --- | --- |
| non-production | any | immediate, optimistic, undo toast |
| production | 0% or already 100% | immediate, optimistic, undo toast |
| production | partial, or turning on from 0% | typed confirmation naming the flag |

A confirmation dialog on every toggle trains people to click through it. One that appears
only when a change reaches live users keeps its meaning.

## Views

### 1. Flag list — `/projects/:slug/:envKey`

The screen people live in. Shows every flag with its state, rollout and last change.

| State | Condition | What renders |
| --- | --- | --- |
| loading | first fetch in flight | 6 skeleton rows at the real row height, so nothing shifts when data lands |
| empty | no flags in this environment | "No flags yet" with a primary Create flag action and one line explaining what a flag is |
| empty (filtered) | filter excludes everything | "No flags match *term*" with a Clear filter action — distinct from having no flags, because the recovery differs |
| partial | page 1 of n loaded | rows plus a Load more control showing how many remain |
| error | fetch failed | "Could not load flags" with Retry; any previously loaded rows stay visible rather than being replaced by the error |
| success | rows present, all loaded | rows, no trailing control |

Each row: flag key, enabled toggle, rollout summary ("100%", "10% treatment", "3 rules"),
last changed relative time, and the actor who changed it.

### 2. Flag detail — `/flags/:id`

Rule editor. The ordered rule list is the screen's whole purpose, so its states are the
rule list's states.

| State | What renders |
| --- | --- |
| loading | skeleton of the header and one rule card |
| empty | "No rules. Every user gets *default*." with Add rule — the empty state states the resulting behavior, not just the absence |
| error | "Could not load this flag" with Retry; the editor is not rendered half-populated |
| success | ordered rule cards, drag handles, Add rule |
| saving | rules dim to 60% opacity, Save shows a spinner, inputs stay enabled so edits are not lost |
| conflict | someone else changed this flag while editing: a banner offering Reload or Overwrite, with both versions summarized |

The conflict state exists because the dashboard is live. Two people editing one flag is
normal, and silently overwriting is the behavior that erodes trust in the tool.

### 3. Audit log — `/environments/:id/audit`

| State | What renders |
| --- | --- |
| loading | skeleton rows |
| empty | "No changes recorded yet" |
| partial | entries plus Load older |
| error | "Could not load history" with Retry |
| success | entries, oldest boundary marked |

Each entry shows actor, action, relative and absolute timestamps, and a before/after diff.
Entries are never editable, matching the database guarantee.

### 4. API keys — `/environments/:id/keys`

| State | What renders |
| --- | --- |
| loading | skeleton rows |
| empty | "No keys yet" with Create key and one line on the admin/client distinction |
| error | "Could not load keys" with Retry |
| success | rows showing name, scope, prefix, created, last used |
| revealed | one-time full key after creation, with Copy, and a warning that it will not be shown again |

**The revealed state is the only place a plaintext key exists.** It is never re-fetchable,
is not written to browser storage, and is cleared from component state on navigation.

## Interaction budget

| Input | Rule | Why |
| --- | --- | --- |
| Flag filter | debounce 300 ms, cancel superseded via `AbortSignal` | Inside the 250–400 ms band: batches typing without feeling laggy |
| Audit search | debounce 400 ms | Heavier query, and intent is more deliberate |
| Percentage slider | update local state live, commit debounced 500 ms | Dragging must feel continuous; writes must not fire per pixel |
| Flag toggle | fire immediately, no debounce | A deliberate single action. Debouncing it would feel broken |
| Rule reorder | commit on drop, never during drag | — |
| Window resize | throttle 100 ms | — |
| SSE reconnect | 1s, 2s, 4s, 8s, capped at 30s, ±20% jitter | Jitter prevents every dashboard reconnecting in lockstep after an API restart |

Every request carries an `AbortSignal`. A superseded request is aborted, never allowed to
resolve into state. This is what prevents the classic bug where a slow response for `"a"`
lands after a fast one for `"abc"` and overwrites it.

## Optimistic updates

| Mutation | Optimistic? | On failure |
| --- | --- | --- |
| Toggle flag | yes | revert the toggle, error toast naming the flag, row border flashes red once |
| Reorder rules | yes | restore previous order, error toast |
| Edit percentage | yes | restore previous value |
| Create flag | no | the server assigns the id, and a fake row that then changes identity is worse than a 200 ms wait |
| Delete flag | no | irreversible; waits for confirmation |
| Create API key | no | the response carries the only copy of the secret |

Optimistic rollback restores the **captured previous value**, not a re-fetch. A re-fetch
can race a concurrent change by another user and resurrect a value nobody chose.

Every optimistic action gets an undo toast for 8 seconds. Undo issues the inverse request;
it does not manipulate local state alone.

## Live updates

The dashboard consumes the same SSE stream as the SDKs.

- A flag changed by someone else updates in place, with a 1.5s highlight on the changed row.
- **A row the current user is editing never updates underneath them.** It enters the
  conflict state instead.
- Connection loss shows a persistent "Reconnecting…" bar. The dashboard stays usable and
  read-only-safe; mutations are still allowed and simply fail loudly if the API is down.
- On reconnect, the full ruleset is re-fetched rather than replaying missed events.

## Accessibility

Decided now, because retrofitting is where it gets dropped.

- **Toggles are `<button role="switch" aria-checked>`**, not styled checkboxes, and are
  reachable and operable by keyboard with Space and Enter.
- Every toggle has an accessible name including the flag key, so a screen reader announces
  "new-checkout, switch, on" rather than "switch, on".
- **State changes are announced.** `role="status" aria-live="polite"` for loading and
  result counts; `role="alert"` for errors. A toggle result announces "new-checkout enabled".
- Rule reordering is keyboard-operable: a focused rule moves with Ctrl+Arrow. Drag and drop
  is an enhancement, never the only path.
- Focus is managed on dialogs: focus moves to the dialog, is trapped inside it, and returns
  to the trigger on close. Escape closes.
- Rollout state is never conveyed by color alone — every enabled flag carries a text label
  as well as a colored pill.
- Contrast meets 4.5:1 for text and 3:1 for interactive boundaries, in both themes.
- `prefers-reduced-motion` removes the row highlight and all transitions.
- The confirmation dialog's typed input is a normal labelled text field, not a trick.

## Responsive behavior

| Breakpoint | Layout |
| --- | --- |
| < 640px | single column; flag rows stack key over metadata; toggle stays right-aligned and at least 44×44px; nav collapses to a menu |
| 640–1024px | rows become two columns; sidebar is an overlay |
| > 1024px | persistent sidebar with projects and environments; full table layout |

The flag list is the one view that must work on a phone, because the thing people do from
a phone is turn a flag off during an incident. That path — open, find flag, toggle off —
is tested at 375px width.

## Stage 3 exit gate

Every view above names all of its states including empty and error, every input that
triggers a network call states its debounce and cancellation rule, and every mutation
states whether it is optimistic and what rollback restores.

Next: Stage 4, implementation and layering.
