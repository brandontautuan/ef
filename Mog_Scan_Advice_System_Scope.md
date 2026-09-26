# Mog Scan — User-Facing Advice System Scope

## Decision

Do not derive appearance advice from the current score logs. The current regression model returns a single subjective rating and cannot establish why a person received it. Instead, ship two clearly separated systems:

1. **Scan notes (MVP):** practical camera/presentation guidance derived from observable frame-quality signals.
2. **Appearance advice (future research):** only if a separately validated, licensed, and safety-reviewed attribution/advice system is built.

The score remains a model estimate from the scan. It is never presented as a diagnosis, objective truth, or evidence that a specific facial feature caused the score.

## A. Scan notes — MVP scope

### User outcome

After the result, show a compact card titled `Make your next scan more consistent`. It gives at most two specific, non-judgmental suggestions based on the scan’s observed camera conditions, plus one positive confirmation when appropriate.

Examples:

| Observed signal | User-facing note |
| --- | --- |
| Low/uneven brightness or low contrast | `Try brighter, more even front lighting.` |
| Face angle/roll outside the configured gate | `Face forward and keep your head level.` |
| Motion or low sharpness | `Hold still for a sharper capture.` |
| Face small, off-center, or near crop boundary | `Center your face and move a little closer.` |
| Valid stable frames with no recurring concern | `Framing and stability looked good.` |

Do not say “improve your appearance,” “fix,” “flaw,” “symmetry,” “more attractive,” or imply that a camera-quality condition caused the final score.

### Data to record only in memory

During one active scan, collect aggregate-safe diagnostic counters—not images or landmarks:

```ts
type ScanQualitySummary = {
  rejectedFrames: Record<QualityFailure, number>;
  acceptedFrames: number;
  firstEligibleAt?: number;
  completedAt?: number;
};
```

Clear this data on rescan, exit, unmount, and result dismissal. Do not store it in local storage, analytics, or the scoring API request.

### Client implementation

1. Increment a reason counter every time the quality gate rejects a candidate frame.
2. On result, choose a maximum of two tips using deterministic priority: light → pose → motion/blur → framing.
3. Only show a tip when its counter exceeds a tuned threshold; do not surface a one-frame tracker miss.
4. Add a positive note if all completed frames were stable and no concern crosses the threshold.
5. Render `Scan notes` below the score. Keep developer math diagnostics behind `VITE_SCAN_DEBUG=1` only.
6. Add unit tests for tip selection, priority, thresholding, clear-on-rescan, and no-persistence behavior.

### Acceptance criteria

- A user gets no more than two clear, camera-focused notes.
- Identical quality-summary fixtures yield the same notes.
- One transient bad frame does not yield advice.
- Advice neither reads nor sends image pixels after the existing inference request.
- No note claims to explain the model score or a person’s attractiveness.

### Ownership and effort

- **Client owner:** quality-summary accumulator, tip-selection module, result-card UI, unit tests.
- **Joint tuning:** thresholds and wording after device testing.
- **Effort:** small implementation; device testing and copy review are the material work.

## B. Score reliability context — recommended addition

Separately show a neutral scan-confidence status, based only on the prediction spread and frame-quality history:

- `Consistent scan` when three valid predictions are close together.
- `Try another scan for a more consistent estimate` when predictions vary substantially.

This should never be framed as confidence in a person’s appearance. It is confidence in the repeatability of this camera/model measurement.

Implementation requires a configured maximum acceptable spread, a test fixture for high/low spread, and copy review. It should not alter the displayed score behind the user’s back.

## C. Feature-level appearance advice — future research scope

### What is required

A one-number attractiveness regressor is insufficient. A separate system must be designed for advice, with all of the following:

1. **Specific claim definition:** enumerate every permitted suggestion and its evidence standard. For example, a pose/lighting recommendation can rely on measurable imaging signals; a claim about facial proportions requires a different evidence base.
2. **Licensed, consented data:** collect or license data whose consent covers the proposed advice use, not merely attractiveness ratings. Include relevant variation in age, skin tone, facial characteristics, camera type, styling, and lighting.
3. **Ground truth:** determine what “better” means for each recommendation and who judges it. Subjective preferences must not be mislabeled as universal facts.
4. **Attribution validation:** use an interpretable model or a rigorously evaluated attribution method. Test whether the purported signal reliably changes the prediction and whether the explanation remains stable across small image changes.
5. **Bias and harm review:** measure error/impact differences across relevant groups; prohibit sensitive-trait inference, medical/mental-health claims, age estimation, ethnicity inference, identity inference, and derogatory recommendations.
6. **Product safeguards:** age gating where appropriate, clear opt-in, skip/hide controls, no ranking/comparison of others, no persistent advice history by default, and a reporting/feedback path.
7. **Human review:** product, privacy/legal, and subject-matter review of all copy and output categories before launch.

### Architecture if approved

```text
selected frame
  → quality gate (existing)
  → scoring model (single score)
  → separate validated advice/attribution service
  → constrained recommendation IDs
  → reviewed client copy
```

The advice service returns only a small approved set of recommendation IDs and confidence/eligibility metadata—not free-form generated claims. The client maps IDs to reviewed copy. Keep this service independent of the score service so it can be disabled without affecting scanning.

### Launch gates

Feature-level advice remains off until all of these are true:

- Model, weights, and data rights are reviewed for the intended use.
- Consent covers advice generation and evaluation.
- Each allowed recommendation has documented evidence and validation results.
- Bias, harmful-output, repeatability, and red-team tests pass.
- Legal/privacy/product reviewers approve the output policy and UI.

## Recommended delivery order

1. Build scan notes now; they use existing observable quality data and do not speculate about appearance.
2. Add score-repeatability context after collecting controlled device-test scans.
3. Keep feature-level advice as a separate research project with its own model/data/validation approval; do not infer it from raw score logs.
