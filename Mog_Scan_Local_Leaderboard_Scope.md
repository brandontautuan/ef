# Mog Scan — Local Leaderboard Scope

## Goal

Add an **optional, local-only leaderboard** for people who choose to save a scan result on one computer. It is intended for a private demo or consenting group using the same browser profile. It is not a public ranking system, does not identify faces, and does not upload data.

## Product boundary

### Included

- Explicit post-result opt-in: `Save to this device’s leaderboard`.
- User-entered display name with a strict character/length limit.
- Save a displayed score, tier, model version, timestamp, and generated record ID.
- Save the current scan image as a local browser blob with each leaderboard entry. It is used only for on-device Who Mogs Who? playback; it is not uploaded, analyzed, or used for recognition.
- Ranking within the current browser’s local storage.
- Leaderboard screen: top entries, current-user highlight, tier, score, and scan date.
- One record per display name by default; a higher later score replaces the existing entry only after confirmation.
- Per-entry deletion, delete-my-entry action, and `Clear this device’s leaderboard` confirmation.
- Empty-state explanation that records live only on the current browser/device.

### Excluded

- Landmark, embedding, raw-frame, or automatic image/video storage.
- Automatic saving, public posting, accounts, cross-device sync, server database, leaderboards shared with strangers, or scanning/ranking another person without their direct participation.
- Using leaderboard rank for access, moderation, hiring, dating eligibility, rewards with material value, or any consequential decision.

## Consent and interaction flow

```text
Scan result
  → user taps “Save to device leaderboard”
  → consent explanation + display-name field
  → user confirms save
  → local record written
  → user may open local leaderboard
```

Consent copy should state: “This saves your display name, displayed score, tier, model version, date, and this scan photo in this browser only. The photo is only used for local Who Mogs Who? playback. Anyone using this browser profile may see the list. You can delete your entry at any time.”

The save action is off by default. Do not prefill names from camera data or infer identity.

## Data model

Store a single JSON payload under a versioned key such as `mog_scan.leaderboard.v1`.

```ts
type LeaderboardEntry = {
  id: string;
  displayName: string;
  score: number;          // displayed integer 0–100
  tier: string;
  modelVersion: string;
  createdAt: string;      // ISO-8601
  updatedAt: string;      // ISO-8601
};

type LocalLeaderboard = {
  schemaVersion: 1;
  entries: LeaderboardEntry[];
};
```

Do not store `scan_id`, native/raw scores, diagnostics, quality reasons, biometric templates, IP address, or analytics identifiers in leaderboard storage. Store each scan image blob in a separate IndexedDB store keyed by leaderboard record ID; use it only for local playback.

## Local storage behavior

- Use `localStorage` for leaderboard fields and a separate IndexedDB store for saved scan photos; neither requires a backend.
- Limit to 100 entries and validate every decoded record before rendering.
- Sort descending by score, then ascending by `updatedAt` for deterministic ties.
- Normalize display names (trim whitespace), permit 2–20 visible characters, and render as text only—never HTML.
- Catch quota/storage errors and show a recoverable message.
- The existing app’s “no saved scans” statement must be revised to clarify: scans/images are not saved; voluntarily saved leaderboard records are.
- `Clear this device’s leaderboard` removes only the versioned leaderboard key, never unrelated browser data.

## UI scope

### Result page

- Add `Save to device leaderboard` beside `Scan again` and `Save card`.
- On tap, show a small modal/sheet with consent copy, display-name input, and `Save score`.
- If the same display name exists, show the old/new score and ask whether to replace it when the new score is higher. Never silently overwrite an entry.

### Leaderboard page/panel

- Add a `Leaderboard` navigation action from the landing/result view.
- Show `Local to this device` prominently above the list.
- Each row shows rank, display name, score, tier, and date—nothing else.
- Provide entry-level delete only for the current session’s saved record; provide a global `Clear this device’s leaderboard` action with confirmation.
- Explain that the score is a model estimate and the list is for entertainment.

## Components

| Module | Responsibility |
| --- | --- |
| `leaderboardStore.ts` | Schema validation, load/save, sort, capacity limit, delete, reset |
| `LeaderboardSaveSheet.tsx` | Consent, name validation, duplicate/replacement confirmation |
| `LeaderboardView.tsx` | List, empty state, delete/reset controls |
| `main.tsx` | Result action, current scan result handoff, navigation |

Keeping storage logic separate from camera/score code prevents local persistence from accidentally expanding into image or biometric storage.

## Acceptance criteria

- No leaderboard record exists unless a user explicitly confirms save.
- Browser storage inspection shows only the defined non-image fields.
- Reloading the page preserves opted-in records; another browser profile does not receive them.
- Scores rank correctly; tie ordering is deterministic.
- Duplicate-name replacement is explicit and only accepts a higher replacement score.
- A user can delete a record and clear all local records; both actions take effect after reload.
- Malformed local-storage data does not crash the app or execute content.
- No landmark/embedding is written to browser storage or sent to a new endpoint. A scan image is written with each leaderboard save, used only for local playback, and never uploaded.

## Test plan

- Unit: schema parsing, invalid input, sorted ranks, ties, 100-entry cap, duplicate higher/lower replacement, delete, clear, and malformed JSON recovery.
- UI: consent required, save success, cancellation leaves no record, duplicate confirmation, empty state, and reset confirmation.
- Privacy: inspect browser Application/Storage panel and network requests before/after save.
- Manual: test desktop and mobile browser local storage behavior, including private/incognito mode messaging.

## Future: shared leaderboard (not part of this MVP)

A shared/public board requires a separate security and privacy design: authenticated or verified consent, server-side deletion/export, rate limiting/abuse controls, moderation, name/content controls, age/jurisdiction review, retention policy, and an explicit decision about whether such ranking is appropriate. Do not turn the local key into an API upload without that review.

## Recommended build order

1. Implement the store and unit tests.
2. Add save-sheet consent and result-page action.
3. Add leaderboard view and deletion/reset paths.
4. Run storage/network privacy verification.
5. Update user-facing privacy copy and validate on target browsers.
