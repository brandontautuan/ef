# Mog Scan — Local 1v1 Mog Off Scope

## Purpose

Add a same-device, pass-the-phone **1V1 MOG OFF** mode. It is distinct from the invite-code/shared-leaderboard plan in `Mog_Scan_1v1_Shared_Leaderboard_Implementation.md`.

## Flow

```text
1V1 MOG OFF
  → Player 1 completes a normal fresh scan
  → score and selected face crop stay hidden in temporary memory
  → handoff screen: “Player 1 locked — pass the phone”
  → Player 2 completes a normal fresh scan
  → score and selected crop stay hidden in temporary memory
  → existing 15.4-second edit plays the two fresh scans
  → loser stamp at 10.8s; winner and both scores reveal at 11.7s
```

## Boundaries

- Reuse the normal camera/upload crop, quality gate, scoring endpoint, score conversion, tier logic, and existing `MogEdit` timeline. Do not create a comparison scorer.
- Do not show either score, tier, roast, or card after either participant scans.
- Do not write duel data to the local leaderboard, IndexedDB, localStorage, a server, logs, analytics, or a URL.
- Convert each selected frame canvas to a temporary object URL before the next scan can overwrite that canvas. Revoke both URLs when the duel is cancelled, ends, or its edit closes.
- The local duel is lost on refresh by design. It does not overlap with or attempt to emulate the two-device invite-code match protocol.

## UI

- Add a `1V1 MOG OFF` action next to the solo start action.
- Use `PLAYER 1` and `PLAYER 2` labels; no score/name entry is needed before playback.
- Between scans, show a dedicated handoff panel with `Scan Player 2` and `Cancel duel`.
- Feed exactly the two locked contenders into the existing edit player. In duel mode, hide arbitrary participant selectors and Swap; replay and mute remain available.
- Closing the edit clears the ephemeral duel and returns to the normal landing screen.

## Acceptance checks

- Solo scan and upload flows still show their normal result screens.
- A first duel scan never opens the score result screen.
- A second duel scan opens the existing edit with only the two fresh face crops.
- The lower score receives the stamp at the existing 10.8s milestone; the computed winner and scores appear at 11.7s.
- Tie skips the stamp and uses the neutral ending.
- Cancelling, erroring, closing, or refreshing leaves no stored duel record or image URL.
