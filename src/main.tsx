import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { BlackCapsule } from './components/BlackCapsule';
import { MogEdit } from './components/MogEdit';
import { resultCopy } from './resultCopy';
import { clearLeaderboard, loadLeaderboard, normalizeName, rank, saveLeaderboard, type LeaderboardEntry } from './leaderboard';
import { clearLeaderboardPhotos, deleteLeaderboardPhoto, loadLeaderboardPhoto, saveLeaderboardPhoto } from './leaderboardPhotos';
import type { EditFace } from './mogTimeline';
import { ApiError, apiEnabled } from './api/client';
import { ensureSession, refreshSession, useSession } from './api/session';
import { createScan, submitLeaderboard, submitScanFrame, type RegisteredScan } from './social/api';
import type { LeaderboardRow, ServerScanResult } from './social/types';
import { useAppRoute } from './social/useAppRoute';
import { MogFeed } from './components/MogFeed';
import { MogPostDetail } from './components/MogPostDetail';
import { MyMogs } from './components/MyMogs';
import { SharedLeaderboard } from './components/SharedLeaderboard';
import { ShareMogSheet, type ShareSource } from './components/ShareMogSheet';
import './styles.css';

type ScanState = 'idle' | 'permission' | 'acquiring' | 'sampling' | 'paused' | 'analyzing' | 'result' | 'error';
type Landmark = { x: number; y: number; z: number };
type QualityFailure = 'no_face' | 'multiple_faces' | 'too_small' | 'cut_off' | 'pose' | 'dark' | 'blur' | 'motion';
type QualityAssessment = { eligible: boolean; failures: QualityFailure[] };
type CaptureMode = 'live' | 'upload';
// With the shared API enabled, frames go to an owned, registered scan and the
// service computes the result; `serverResult` arrives with the final frame.
type Prediction = { nativeScore: number; modelVersion: string; sequence: number; acceptedFrames?: number; serverResult?: ServerScanResult };
type ScanResult = { score: number; tier: string; modelVersion: string; nativeScores: number[]; medianNativeScore: number; captureMode: CaptureMode; serverResultId?: string };
type SharedSave = { entry: LeaderboardRow; outcome: 'inserted' | 'replaced' | 'unchanged' | 'not_higher' } | null;
type LocalDuel = { phase: 'first' | 'handoff' | 'second' | 'editing'; first?: EditFace; second?: EditFace };

const SCAN_TIMEOUT_MS = 28_000;
const SAMPLE_INTERVAL_MS = 1_100;
const REQUIRED_PREDICTIONS = 3;
const scanDebugEnabled = import.meta.env.VITE_SCAN_DEBUG === '1';
const prompts: Record<QualityFailure, string> = {
  no_face: 'Place one face inside the frame',
  multiple_faces: 'Keep just one face in frame',
  too_small: 'Move a little closer',
  cut_off: 'Center your face in the frame',
  pose: 'Face forward',
  dark: 'Find brighter light',
  blur: 'Hold your phone steady',
  motion: 'Hold steady',
};

const tierPlaybooks = [
  { tier: 'LTN', title: 'Foundation', steps: ['Use consistent sleep, simple skincare, and daily sun protection.', 'Choose a haircut and grooming routine that keeps your face clearly visible.', 'Take repeat scans in even daylight or soft front light.'] },
  { tier: 'MTN', title: 'Consistency', steps: ['Keep clothes clean, well-fitted, and intentional rather than chasing every trend.', 'Maintain a repeatable hair, skin, and grooming routine.', 'Use eye-level camera height and relaxed posture in photos.'] },
  { tier: 'HTN', title: 'Polish', steps: ['Refine fit, color coordination, and grooming details that feel like you.', 'Build habits you can sustain: movement, rest, and basic self-care.', 'Use clean lighting and a calm expression for a more consistent camera result.'] },
  { tier: 'CHADLITE', title: 'Presence', steps: ['Lean into a recognizable personal style instead of over-optimizing every feature.', 'Keep posture, hair, and wardrobe consistent across photos and in person.', 'Rescan under similar lighting before judging small score changes.'] },
  { tier: 'CHAD', title: 'Refinement', steps: ['Prioritize confidence, fit, and grooming consistency over drastic changes.', 'Experiment with styling one variable at a time so you know what you prefer.', 'Treat score movement as model noise unless repeated scans agree.'] },
  { tier: 'ADAM', title: 'Signature', steps: ['Keep the habits and style choices that already feel authentic to you.', 'Use the app as entertainment, not a rulebook for your appearance.', 'Help keep the vibe positive—do not rank or scan other people.'] },
  { tier: 'TRUE ADAM', title: 'Final form', steps: ['There is no higher unlock. Keep your own standards, not the model’s.', 'Stay grounded: a camera score is not a measurement of worth.', 'Use the share card only if you genuinely want to.'] },
] as const;

// Messages for the photo-upload path (the live prompts are camera-phrased).
const uploadPrompts: Partial<Record<QualityFailure, string>> = {
  no_face: 'No face found in that photo. Try a clear, front-facing shot.',
  multiple_faces: 'That photo has more than one face. Use a solo photo.',
  too_small: 'The face is too small in that photo. Use a closer shot.',
  cut_off: 'The face is cut off. Use a photo with the whole face in frame.',
  pose: 'Use a front-facing photo — look toward the camera.',
};

function makeScanId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('That image could not be loaded.'));
    image.src = src;
  });
}

// Ensure the web fonts the result card draws with are loaded before rendering to
// canvas; otherwise the first render falls back to a system font.
async function ensureCardFonts(): Promise<void> {
  try {
    await Promise.all([
      document.fonts.load('800 230px "Barlow Condensed"'),
      document.fonts.load('500 66px "Barlow Condensed"'),
      document.fonts.load('900 40px "DM Sans"'),
      document.fonts.load('700 42px "DM Sans"'),
      document.fonts.load('500 26px "DM Mono"'),
    ]);
    await document.fonts.ready;
  } catch { /* fall back to system fonts */ }
}

// Geometric subset of the quality gate: one face, size, framing, and pose.
// Shared by the still-image upload path (motion/brightness checks are live-only).
function geometricGate(faces: Landmark[][]): QualityAssessment {
  if (faces.length === 0) return { eligible: false, failures: ['no_face'] };
  if (faces.length > 1) return { eligible: false, failures: ['multiple_faces'] };
  const face = faces[0];
  const xs = face.map((p) => p.x); const ys = face.map((p) => p.y);
  const left = Math.min(...xs); const right = Math.max(...xs); const top = Math.min(...ys); const bottom = Math.max(...ys);
  if (right - left < .22 || bottom - top < .22) return { eligible: false, failures: ['too_small'] };
  if (left < .03 || right > .97 || top < .03 || bottom > .97) return { eligible: false, failures: ['cut_off'] };
  const leftEye = face[33]; const rightEye = face[263];
  if (leftEye && rightEye && Math.abs(Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x)) > .23) return { eligible: false, failures: ['pose'] };
  const nose = face[1]; const mouth = face[13];
  if (leftEye && rightEye && nose && mouth) {
    const eyeMidX = (leftEye.x + rightEye.x) / 2; const eyeY = (leftEye.y + rightEye.y) / 2;
    const eyeWidth = Math.max(.001, Math.abs(rightEye.x - leftEye.x));
    const faceHeight = Math.max(.001, mouth.y - eyeY);
    if (Math.abs(nose.x - eyeMidX) / eyeWidth > .24 || (nose.y - eyeY) / faceHeight < .35 || (nose.y - eyeY) / faceHeight > .8) return { eligible: false, failures: ['pose'] };
  }
  return { eligible: true, failures: [] };
}

// Crop an aligned face into the 640x640 send canvas, so camera and upload feed
// the model identically. The face is rotated so the eye line is level and scaled
// by INTER-OCULAR DISTANCE (not the landmark box) with the eyes pinned to a
// canonical position. Eye distance barely moves with expression, hair, or an open
// mouth, so the crop's zoom/framing — and thus the score — is far more repeatable
// than a bounding-box crop. Falls back to the box (no eyes) or a centered square.
const FACE_MARGIN = 0.5;              // used only by the no-eye bbox fallback
const OUTPUT_EYE_DISTANCE = 142;      // px between the eyes in the 640 crop (≈ prior zoom)
const OUTPUT_EYE_Y = 296;             // canonical eye-line height in the 640 crop
function cropFaceToCanvas(source: CanvasImageSource, sourceW: number, sourceH: number, face: Landmark[] | undefined, canvas: HTMLCanvasElement): boolean {
  if (sourceW === 0 || sourceH === 0) return false;
  canvas.width = 640;
  canvas.height = 640;
  const context = canvas.getContext('2d');
  if (!context) return false;
  context.fillStyle = '#000';
  context.fillRect(0, 0, 640, 640); // letterbox any area alignment brings outside the source
  const leftEye = face?.[33]; const rightEye = face?.[263];
  if (face && face.length && leftEye && rightEye) {
    const lx = leftEye.x * sourceW; const ly = leftEye.y * sourceH;
    const rx = rightEye.x * sourceW; const ry = rightEye.y * sourceH;
    const eyeMidX = (lx + rx) / 2; const eyeMidY = (ly + ry) / 2;
    const interOcular = Math.hypot(rx - lx, ry - ly) || 1;
    const angle = Math.atan2(ry - ly, rx - lx);
    const scale = OUTPUT_EYE_DISTANCE / interOcular;
    context.save();
    context.translate(320, OUTPUT_EYE_Y); // eye midpoint -> canonical position
    context.rotate(-angle);               // level the eyes
    context.scale(scale, scale);          // normalize by inter-ocular distance
    context.translate(-eyeMidX, -eyeMidY);
    context.drawImage(source, 0, 0);
    context.restore();
  } else if (face && face.length) {
    // Fallback (no eye landmarks): face bbox center + margin, rotation skipped.
    const xs = face.map((p) => p.x); const ys = face.map((p) => p.y);
    const left = Math.min(...xs) * sourceW; const right = Math.max(...xs) * sourceW;
    const top = Math.min(...ys) * sourceH; const bottom = Math.max(...ys) * sourceH;
    const cx = (left + right) / 2; const cy = (top + bottom) / 2;
    const boxSide = Math.min(Math.max(right - left, bottom - top) * (1 + FACE_MARGIN), sourceW, sourceH);
    context.drawImage(source, cx - boxSide / 2, cy - boxSide / 2, boxSide, boxSide, 0, 0, 640, 640);
  } else {
    const sSide = Math.min(sourceW, sourceH);
    context.drawImage(source, (sourceW - sSide) / 2, (sourceH - sSide) / 2, sSide, sSide, 0, 0, 640, 640);
  }
  return true;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Display scores use the full native range declared by the active model package,
// then apply a small +10 presentation offset (capped at 100). This is a
// placeholder conversion, not a percentile or a validated population calibration.
//
// Keeping this aligned with the server's `linear-1-5-plus-10-v1` map matters:
// registered and local scans must show the same result for the same native score.
const DISPLAY_NATIVE_MIN = 1.0;
const DISPLAY_NATIVE_MAX = 5.0;
const DISPLAY_SCORE_OFFSET = 10;

function displayScore(nativeScore: number) {
  const span = DISPLAY_NATIVE_MAX - DISPLAY_NATIVE_MIN;
  return Math.round(Math.min(100, Math.max(0, ((nativeScore - DISPLAY_NATIVE_MIN) / span) * 100 + DISPLAY_SCORE_OFFSET)));
}

function tierFor(score: number) {
  if (score >= 97) return 'TRUE ADAM';
  if (score >= 90) return 'ADAM';
  if (score >= 81) return 'CHAD';
  if (score >= 74) return 'CHADLITE';
  if (score >= 60) return 'HTN';
  if (score >= 43) return 'MTN';
  if (score >= 27) return 'LTN';
  return 'SUB5';
}

function isMediaSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

function scanDebug(event: string, details: Record<string, unknown>) {
  if (scanDebugEnabled) console.info(`[MOG scan] ${event}`, details);
}

async function scoreFrame(canvas: HTMLCanvasElement, scanId: string, sequence: number): Promise<Prediction> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
  if (!blob) throw new Error('Could not prepare selected frame.');

  const endpoint = import.meta.env.VITE_SCORE_ENDPOINT;
  if (!endpoint) {
    // A deliberate development stub: replace with VITE_SCORE_ENDPOINT for real inference.
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    return { nativeScore: 2.7 + Math.random() * 1.45, modelVersion: 'mock-ui-v1', sequence };
  }

  const data = new FormData();
  data.append('image', blob, 'selected-face.jpg');
  data.append('scan_id', scanId);
  data.append('frame_sequence', String(sequence));
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(endpoint, { method: 'POST', body: data, signal: controller.signal });
    if (!response.ok) throw new Error('The scoring service is unavailable. Please retry.');
    const payload = await response.json() as { native_score: number; model_version: string };
    if (!Number.isFinite(payload.native_score)) throw new Error('The scoring service returned an invalid result.');
    return { nativeScore: payload.native_score, modelVersion: payload.model_version, sequence };
  } finally {
    window.clearTimeout(timeout);
  }
}

// Registered-scan path: same selected crop, but the service records the result.
async function scoreRegisteredFrame(canvas: HTMLCanvasElement, scan: RegisteredScan, sequence: number): Promise<Prediction> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
  if (!blob) throw new Error('Could not prepare selected frame.');
  const ack = await submitScanFrame(scan.scan_id, blob, sequence);
  return { nativeScore: ack.native_score ?? Number.NaN, modelVersion: ack.model_version, sequence, acceptedFrames: ack.accepted_frames, serverResult: ack.result ?? undefined };
}

// Registration runs concurrently with the camera start; null means the legacy
// (unrecorded, local-only) scoring path is used for this scan.
function registerScan(mode: CaptureMode): Promise<RegisteredScan | null> | null {
  if (!apiEnabled) return null;
  return ensureSession().then(() => createScan(mode)).catch((error) => {
    scanDebug('scan_registration_failed', { code: error instanceof ApiError ? error.code : 'unknown' });
    return null;
  });
}

function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const activeScanId = useRef('');
  const samplingTimer = useRef<number | null>(null);
  const startupTimer = useRef<number | null>(null);
  const overallTimer = useRef<number | null>(null);
  const requestInFlight = useRef(false);
  const sequence = useRef(0);
  const predictions = useRef<Prediction[]>([]);
  const stateRef = useRef<ScanState>('idle');
  const trackerRef = useRef<FaceLandmarker | null>(null);
  const trackingFrame = useRef<number | null>(null);
  const facesRef = useRef<Array<Array<{ x: number; y: number; z: number }>>>([]);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const qualityCanvasRef = useRef<HTMLCanvasElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const editUrlsRef = useRef<string[]>([]);
  const duelUrlsRef = useRef<string[]>([]);
  const duelRef = useRef<LocalDuel | null>(null);
  const registeredScanRef = useRef<Promise<RegisteredScan | null> | null>(null);
  const previousFaceCenterRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const validSinceRef = useRef<number | null>(null);
  const [state, setState] = useState<ScanState>('idle');
  const [message, setMessage] = useState('Camera stays off until you start.');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [faceFree, setFaceFree] = useState(false);
  const [cardPreview, setCardPreview] = useState<string | null>(null);
  const [introPlaying, setIntroPlaying] = useState(false);
  const [introSequence, setIntroSequence] = useState(0);
  const [hud, setHud] = useState<{ faces: number; box: { l: number; t: number; w: number; h: number } | null; eligible: boolean; note: string }>({ faces: 0, box: null, eligible: false, note: 'INITIALIZING' });
  const [leaderboardOpen, setLeaderboardOpen] = useState(false); const [saveOpen, setSaveOpen] = useState(false); const [displayName, setDisplayName] = useState(''); const [entries, setEntries] = useState<LeaderboardEntry[]>(() => loadLeaderboard()); const [leaderboardError, setLeaderboardError] = useState('');
  const [editOpen, setEditOpen] = useState(false); const [editLoading, setEditLoading] = useState(false); const [editFaces, setEditFaces] = useState<EditFace[]>([]);
  const [duel, setDuel] = useState<LocalDuel | null>(null);
  const { route, navigate } = useAppRoute();
  const session = useSession();
  const [leaderboardTab, setLeaderboardTab] = useState<'shared' | 'local'>(apiEnabled ? 'shared' : 'local');
  const [sharedSave, setSharedSave] = useState<SharedSave>(null);
  const [confirmReplace, setConfirmReplace] = useState<{ currentScore: number; newScore: number } | null>(null);
  const [keepLocal, setKeepLocal] = useState(true);
  const [saving, setSaving] = useState(false);
  const [shareSource, setShareSource] = useState<ShareSource | null>(null);
  const socialRoute = apiEnabled && route.name !== 'home';

  useEffect(() => { if (apiEnabled) void refreshSession().catch(() => undefined); }, []);

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { duelRef.current = duel; }, [duel]);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const clearScanTimers = useCallback(() => {
    if (startupTimer.current) window.clearTimeout(startupTimer.current);
    if (samplingTimer.current) window.clearInterval(samplingTimer.current);
    if (overallTimer.current) window.clearTimeout(overallTimer.current);
    samplingTimer.current = null;
    overallTimer.current = null;
    startupTimer.current = null;
  }, []);

  const stopTracking = useCallback(() => {
    if (trackingFrame.current) cancelAnimationFrame(trackingFrame.current);
    trackingFrame.current = null;
    facesRef.current = [];
    trackerRef.current?.close();
    trackerRef.current = null;
  }, []);

  const resetScan = useCallback(() => {
    clearScanTimers();
    activeScanId.current = makeScanId();
    sequence.current = 0;
    predictions.current = [];
    requestInFlight.current = false;
    validSinceRef.current = null;
    previousFaceCenterRef.current = null;
    registeredScanRef.current = null;
    setProgress(0);
    setResult(null);
    setSharedSave(null);
    setConfirmReplace(null);
  }, [clearScanTimers]);

  useEffect(() => () => { activeScanId.current = makeScanId(); clearScanTimers(); stopTracking(); stopCamera(); }, [clearScanTimers, stopCamera, stopTracking]);
  useEffect(() => () => { editUrlsRef.current.forEach((url) => URL.revokeObjectURL(url)); }, []);
  useEffect(() => () => { duelUrlsRef.current.forEach((url) => URL.revokeObjectURL(url)); }, []);

  useEffect(() => {
    if (state === 'result' || state === 'error' || state === 'idle') {
      clearScanTimers(); stopTracking(); stopCamera();
    }
  }, [state, clearScanTimers, stopTracking, stopCamera]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && (state === 'sampling' || state === 'acquiring')) {
        clearScanTimers();
        setState('paused');
        setMessage('Scan paused — return when you’re ready.');
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [clearScanTimers, state]);

  const assessFrame = useCallback((): QualityAssessment => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return { eligible: false, failures: ['no_face'] };
    const faces = facesRef.current;
    if (faces.length === 0) return { eligible: false, failures: ['no_face'] };
    if (faces.length > 1) return { eligible: false, failures: ['multiple_faces'] };
    const face = faces[0];
    const xs = face.map((point) => point.x); const ys = face.map((point) => point.y);
    const left = Math.min(...xs); const right = Math.max(...xs); const top = Math.min(...ys); const bottom = Math.max(...ys);
    if (right - left < .22 || bottom - top < .22) return { eligible: false, failures: ['too_small'] };
    if (left < .03 || right > .97 || top < .03 || bottom > .97) return { eligible: false, failures: ['cut_off'] };
    // Landmark roll is a lightweight frontal-pose guard. Yaw/pitch thresholds can be added
    // after device tuning without changing the scan protocol.
    const leftEye = face[33]; const rightEye = face[263];
    if (leftEye && rightEye && Math.abs(Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x)) > .23) {
      return { eligible: false, failures: ['pose'] };
    }
    // A conservative frontal-pose estimate. These thresholds are configuration
    // candidates and must be tuned with consented device recordings before launch.
    const nose = face[1]; const mouth = face[13];
    if (leftEye && rightEye && nose && mouth) {
      const eyeMidX = (leftEye.x + rightEye.x) / 2;
      const eyeY = (leftEye.y + rightEye.y) / 2;
      const eyeWidth = Math.max(.001, Math.abs(rightEye.x - leftEye.x));
      const faceHeight = Math.max(.001, mouth.y - eyeY);
      if (Math.abs(nose.x - eyeMidX) / eyeWidth > .24 || (nose.y - eyeY) / faceHeight < .35 || (nose.y - eyeY) / faceHeight > .8) return { eligible: false, failures: ['pose'] };
    }
    const now = performance.now();
    const center = { x: (left + right) / 2, y: (top + bottom) / 2, at: now };
    const previous = previousFaceCenterRef.current;
    previousFaceCenterRef.current = center;
    if (previous && now - previous.at < 350 && Math.hypot(center.x - previous.x, center.y - previous.y) > .035) return { eligible: false, failures: ['motion'] };
    const qualityCanvas = qualityCanvasRef.current;
    if (qualityCanvas) {
      const context = qualityCanvas.getContext('2d', { willReadFrequently: true });
      if (context) {
        qualityCanvas.width = 64; qualityCanvas.height = 64;
        const sx = Math.max(0, left * video.videoWidth); const sy = Math.max(0, top * video.videoHeight);
        const sw = Math.min(video.videoWidth - sx, (right - left) * video.videoWidth); const sh = Math.min(video.videoHeight - sy, (bottom - top) * video.videoHeight);
        context.drawImage(video, sx, sy, sw, sh, 0, 0, 64, 64);
        const pixels = context.getImageData(0, 0, 64, 64).data;
        let sum = 0; let sumSq = 0; let edge = 0; let count = 0;
        const lum = (i: number) => .2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2];
        for (let y = 1; y < 63; y += 1) for (let x = 1; x < 63; x += 1) {
          const i = (y * 64 + x) * 4; const value = lum(i); sum += value; sumSq += value * value; count += 1;
          edge += Math.abs(value - lum(i - 4)) + Math.abs(value - lum(i - 64 * 4));
        }
        const mean = sum / count; const deviation = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
        if (mean < 45 || mean > 235 || deviation < 16) return { eligible: false, failures: ['dark'] };
        if (edge / count < 13) return { eligible: false, failures: ['blur'] };
      }
    }
    return { eligible: true, failures: [] };
  }, []);

  // Live HUD telemetry: poll the tracker a few times a second and derive the
  // futuristic readouts. Kept separate from the sampling loop so it never
  // affects scoring; it only reflects what the tracker already sees.
  useEffect(() => {
    if (!(state === 'acquiring' || state === 'sampling' || state === 'paused')) return;
    const id = window.setInterval(() => {
      const faces = facesRef.current;
      const assessment = assessFrame();
      let box: { l: number; t: number; w: number; h: number } | null = null;
      if (faces.length === 1) {
        const xs = faces[0].map((p) => p.x); const ys = faces[0].map((p) => p.y);
        const left = Math.min(...xs); const right = Math.max(...xs);
        const top = Math.min(...ys); const bottom = Math.max(...ys);
        // The video is mirrored (scaleX(-1)), so flip X to match what the user sees.
        box = { l: (1 - right) * 100, t: top * 100, w: (right - left) * 100, h: (bottom - top) * 100 };
      }
      const note = assessment.eligible
        ? 'LOCK ACQUIRED'
        : faces.length === 0
          ? 'AWAITING SUBJECT'
          : faces.length > 1
            ? 'MULTIPLE SUBJECTS'
            : prompts[assessment.failures[0]].toUpperCase();
      setHud({ faces: faces.length, box, eligible: assessment.eligible, note });
    }, 140);
    return () => window.clearInterval(id);
  }, [state, assessFrame]);

  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = frameCanvasRef.current;
    if (!video || !canvas) return false;
    // Crop to the detected face (not a fixed center square), so the model sees a
    // consistently framed face regardless of distance. A whole-frame crop made the
    // score track how much of the frame the face filled — far away read as 0.
    return cropFaceToCanvas(video, video.videoWidth, video.videoHeight, facesRef.current[0], canvas);
  }, []);

  const lockDuelResult = useCallback((scanResult: ScanResult) => {
    const currentDuel = duelRef.current;
    const slot = currentDuel?.phase;
    const canvas = frameCanvasRef.current;
    if (!currentDuel || !canvas || (slot !== 'first' && slot !== 'second')) return false;
    clearScanTimers(); stopTracking(); stopCamera();
    stateRef.current = 'analyzing'; setState('analyzing'); setMessage(`Locking Player ${slot === 'first' ? '1' : '2'}…`);
    canvas.toBlob((photo) => {
      if (!photo || duelRef.current?.phase !== slot) { setState('error'); setMessage('Could not keep the selected frame. Please retry the duel.'); return; }
      const imageUrl = URL.createObjectURL(photo);
      duelUrlsRef.current.push(imageUrl);
      const now = new Date().toISOString();
      const contender: EditFace = { id: makeScanId(), displayName: slot === 'first' ? 'PLAYER 1' : 'PLAYER 2', score: scanResult.score, tier: scanResult.tier, modelVersion: scanResult.modelVersion, createdAt: now, updatedAt: now, imageUrl, lowResolution: false };
      if (slot === 'first') {
        const next: LocalDuel = { phase: 'handoff', first: contender };
        duelRef.current = next; setDuel(next); setState('idle'); setMessage('Player 1 locked. Pass the phone.'); return;
      }
      const next: LocalDuel = { phase: 'editing', first: currentDuel.first, second: contender };
      duelRef.current = next; setDuel(next); setEditLoading(false); setEditOpen(true); setState('idle'); setMessage('Both players locked.');
    }, 'image/jpeg', .9);
    return true;
  }, [clearScanTimers, stopCamera, stopTracking]);

  const finish = useCallback((items: Prediction[], captureMode: CaptureMode, serverResult?: ServerScanResult) => {
    clearScanTimers();
    const modelVersion = serverResult?.modelVersion ?? items[0].modelVersion;
    if (items.some((item) => item.modelVersion !== modelVersion)) {
      setState('error');
      setMessage('The model changed during this scan. Please scan again.');
      return;
    }
    const nativeScores = items.map((item) => item.nativeScore);
    const medianNativeScore = median(nativeScores);
    // A registered scan's score and tier come from the service, never the browser.
    const score = serverResult?.score ?? displayScore(medianNativeScore);
    scanDebug('result_locked', {
      frames: items.length,
      nativeScores: nativeScores.map((value) => Number(value.toFixed(3))),
      aggregation: 'median',
      medianNativeScore: Number(medianNativeScore.toFixed(3)),
      displayFormula: 'clamp(round(((native - 1.0) / 4.0) * 100 + 10), 0, 100)',
      displayScore: score,
      tier: serverResult?.tier ?? tierFor(score),
      modelVersion,
      serverResultId: serverResult?.id ?? null,
    });
    const scanResult: ScanResult = { score, tier: serverResult?.tier ?? tierFor(score), modelVersion, nativeScores, medianNativeScore, captureMode, serverResultId: serverResult?.id };
    if (lockDuelResult(scanResult)) return;
    setResult(scanResult);
    setState('result');
    setMessage('Result locked from this scan.');
  }, [clearScanTimers, lockDuelResult]);

  const sample = useCallback(async () => {
    // The loop stays active in both 'sampling' and 'paused' so it can recover
    // when quality returns; it only stops once the scan leaves those states.
    if (requestInFlight.current) return;
    if (stateRef.current !== 'sampling' && stateRef.current !== 'paused') return;
    const assessment = assessFrame();
    if (!assessment.eligible) {
      scanDebug('frame_rejected', { reason: assessment.failures[0], allFailures: assessment.failures, scanId: activeScanId.current });
      validSinceRef.current = null;
      if (stateRef.current !== 'paused') {
        stateRef.current = 'paused';
        setState('paused');
      }
      setMessage(prompts[assessment.failures[0]]);
      return;
    }
    // Quality recovered (or held steady): resume sampling, keeping any progress.
    if (stateRef.current !== 'sampling') {
      stateRef.current = 'sampling';
      setState('sampling');
      setMessage('Hold that pose…');
    }
    if (validSinceRef.current === null) validSinceRef.current = performance.now();
    if (performance.now() - validSinceRef.current < 700) {
      scanDebug('quality_hold', { requiredMs: 700, scanId: activeScanId.current });
      setMessage('Hold that pose…');
      return;
    }
    if (!captureFrame()) return;
    requestInFlight.current = true;
    const scanId = activeScanId.current;
    const frameSequence = ++sequence.current;
    try {
      const registered = registeredScanRef.current ? await registeredScanRef.current : null;
      if (scanId !== activeScanId.current) return;
      const prediction = registered
        ? await scoreRegisteredFrame(frameCanvasRef.current!, registered, frameSequence)
        : await scoreFrame(frameCanvasRef.current!, scanId, frameSequence);
      if (scanId !== activeScanId.current || (stateRef.current !== 'sampling' && stateRef.current !== 'paused')) return;
      const next = [...predictions.current, prediction];
      predictions.current = next;
      if (registered) {
        const accepted = prediction.acceptedFrames ?? next.length;
        setProgress(Math.round((accepted / REQUIRED_PREDICTIONS) * 100));
        setMessage(accepted === REQUIRED_PREDICTIONS - 1 ? 'One more frame…' : 'Hold that pose…');
        if (prediction.serverResult) finish(next, 'live', prediction.serverResult);
        return;
      }
      scanDebug('frame_scored', {
        scanId,
        frameSequence,
        nativeScore: Number(prediction.nativeScore.toFixed(3)),
        modelVersion: prediction.modelVersion,
        acceptedFrames: next.length,
        requiredFrames: REQUIRED_PREDICTIONS,
      });
      setProgress(Math.round((next.length / REQUIRED_PREDICTIONS) * 100));
      setMessage(next.length === REQUIRED_PREDICTIONS - 1 ? 'One more frame…' : 'Hold that pose…');
      if (next.length >= REQUIRED_PREDICTIONS) finish(next, 'live');
    } catch (error) {
      scanDebug('score_error', { scanId, frameSequence, message: error instanceof Error ? error.message : 'Unknown error' });
      if (scanId === activeScanId.current) {
        clearScanTimers();
        setState('error');
        setMessage(error instanceof Error ? error.message : 'Scoring failed. Please retry.');
      }
    } finally {
      if (scanId === activeScanId.current) requestInFlight.current = false;
    }
  }, [assessFrame, captureFrame, clearScanTimers, finish]);

  const beginSampling = useCallback(() => {
    stateRef.current = 'sampling';
    setState('sampling');
    setMessage('Hold that pose…');
    startupTimer.current = window.setTimeout(() => void sample(), 250);
    samplingTimer.current = window.setInterval(() => void sample(), SAMPLE_INTERVAL_MS);
  }, [sample]);

  const initializeTracker = useCallback(async (scanId: string) => {
    const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm');
    const tracker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task' },
      runningMode: 'VIDEO',
      numFaces: 2,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
    if (scanId !== activeScanId.current) { tracker.close(); return; }
    trackerRef.current = tracker;
    const detect = () => {
      const video = videoRef.current;
      if (!video || !trackerRef.current || !streamRef.current) return;
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        const detection = trackerRef.current.detectForVideo(video, performance.now());
        facesRef.current = detection.faceLandmarks.map((face) => face.map(({ x, y, z }) => ({ x, y, z })));
        const overlay = overlayRef.current;
        if (overlay) {
          const rect = overlay.getBoundingClientRect(); const ratio = devicePixelRatio || 1;
          overlay.width = rect.width * ratio; overlay.height = rect.height * ratio;
          const context = overlay.getContext('2d');
          if (context && video.videoWidth) {
            context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, rect.width, rect.height);
            const scale = Math.max(rect.width / video.videoWidth, rect.height / video.videoHeight);
            const width = video.videoWidth * scale; const height = video.videoHeight * scale;
            const offsetX = (rect.width - width) / 2; const offsetY = (rect.height - height) / 2;
            context.fillStyle = '#e5e2dc';
            for (const point of facesRef.current[0] ?? []) context.fillRect(rect.width - (point.x * width + offsetX) - 1, point.y * height + offsetY - 1, 2, 2);
          }
        }
      }
      trackingFrame.current = requestAnimationFrame(detect);
    };
    detect();
  }, []);

  const startCamera = useCallback(async () => {
    if (!isMediaSupported()) {
      setState('error');
      setMessage('This browser does not support camera access. Try a current Chrome or Safari browser.');
      return;
    }
    stopTracking(); stopCamera(); resetScan();
    const scanId = activeScanId.current;
    // Match/duel scans stay local; solo scans register with the service concurrently.
    registeredScanRef.current = duelRef.current ? null : registerScan('live');
    setIntroSequence((value) => value + 1);
    setIntroPlaying(true);
    stateRef.current = 'permission'; setState('permission');
    setMessage('Allow camera access to begin your live scan.');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
      if (scanId !== activeScanId.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      await initializeTracker(scanId);
      if (scanId !== activeScanId.current) return;
      scanDebug('camera_started', { scanId: activeScanId.current, tracker: 'MediaPipe Face Landmarker', requiredFrames: REQUIRED_PREDICTIONS });
      setState('acquiring');
      setMessage('Center your face in the frame');
      startupTimer.current = window.setTimeout(beginSampling, 800);
      overallTimer.current = window.setTimeout(() => {
        clearScanTimers();
        setState('error');
        setMessage('The scan timed out. Try again in brighter, steadier light.');
      }, SCAN_TIMEOUT_MS);
    } catch {
      if (scanId !== activeScanId.current) return;
      stopTracking();
      stopCamera();
      setState('error');
      setMessage('Camera access was not granted. Enable it in browser settings, then retry.');
    }
  }, [beginSampling, clearScanTimers, initializeTracker, resetScan, stopCamera, stopTracking]);

  const clearDuel = useCallback(() => {
    duelUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    duelUrlsRef.current = [];
    duelRef.current = null;
    setDuel(null);
  }, []);

  const startLocalDuel = useCallback(() => {
    clearDuel();
    const next: LocalDuel = { phase: 'first' };
    duelRef.current = next; setDuel(next);
    void startCamera();
  }, [clearDuel, startCamera]);

  const startSecondDuelScan = useCallback(() => {
    const currentDuel = duelRef.current;
    if (!currentDuel?.first) return;
    const next: LocalDuel = { phase: 'second', first: currentDuel.first };
    duelRef.current = next; setDuel(next);
    void startCamera();
  }, [startCamera]);

  // Photo-upload path: detect a face in a still image, run the geometric quality
  // gate, crop to the face, and score that single crop. Only the crop is sent
  // (never the raw upload), and the object URL + detector are released after.
  const scanImage = useCallback(async (file: File) => {
    stopTracking(); stopCamera(); resetScan();
    const scanId = activeScanId.current;
    registeredScanRef.current = registerScan('upload');
    stateRef.current = 'analyzing'; setState('analyzing');
    setMessage('Reading your photo…');
    let objectUrl: string | null = null;
    let landmarker: FaceLandmarker | null = null;
    try {
      if (!file.type.startsWith('image/')) throw new Error('Please choose an image file.');
      objectUrl = URL.createObjectURL(file);
      const image = await loadImage(objectUrl);
      if (scanId !== activeScanId.current) return;
      const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm');
      landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task' },
        runningMode: 'IMAGE',
        numFaces: 2,
      });
      if (scanId !== activeScanId.current) return;
      const detection = landmarker.detect(image);
      const faces = detection.faceLandmarks.map((face) => face.map(({ x, y, z }) => ({ x, y, z })));
      const gate = geometricGate(faces);
      if (!gate.eligible) {
        scanDebug('upload_rejected', { reason: gate.failures[0], scanId });
        setState('error');
        setMessage(uploadPrompts[gate.failures[0]] ?? 'That photo could not be scanned. Try another.');
        return;
      }
      if (!cropFaceToCanvas(image, image.naturalWidth, image.naturalHeight, faces[0], frameCanvasRef.current!)) {
        throw new Error('Could not prepare the photo.');
      }
      setMessage('Scoring your photo…');
      requestInFlight.current = true;
      const registered = registeredScanRef.current ? await registeredScanRef.current : null;
      if (scanId !== activeScanId.current) return;
      const prediction = registered
        ? await scoreRegisteredFrame(frameCanvasRef.current!, registered, ++sequence.current)
        : await scoreFrame(frameCanvasRef.current!, scanId, ++sequence.current);
      if (scanId !== activeScanId.current) return;
      scanDebug('upload_scored', { scanId, nativeScore: Number(prediction.nativeScore.toFixed(3)), modelVersion: prediction.modelVersion });
      finish([prediction], 'upload', prediction.serverResult);
    } catch (error) {
      scanDebug('upload_error', { scanId, message: error instanceof Error ? error.message : 'Unknown error' });
      if (scanId === activeScanId.current) {
        setState('error');
        setMessage(error instanceof Error ? error.message : 'That photo could not be scanned. Try another.');
      }
    } finally {
      if (scanId === activeScanId.current) requestInFlight.current = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      landmarker?.close();
    }
  }, [finish, resetScan, stopCamera, stopTracking]);

  const exitScanRef = useRef<() => void>(() => undefined);
  const scanAgain = useCallback(() => { stopTracking(); stopCamera(); void startCamera(); }, [startCamera, stopCamera, stopTracking]);
  const exitScan = useCallback(() => {
    setIntroPlaying(false);
    activeScanId.current = makeScanId();
    clearDuel(); clearScanTimers(); stopTracking(); stopCamera(); stateRef.current = 'idle'; setState('idle'); setMessage('Camera stays off until you start.'); setProgress(0); setResult(null);
  }, [clearDuel, clearScanTimers, stopCamera, stopTracking]);
  exitScanRef.current = exitScan;

  // Render the shareable "receipt" card, matched to the site theme (matte black,
  // Barlow Condensed score, DM Mono labels, red accents, hairline border). Used by
  // both the on-screen preview and the download so they stay identical.
  const renderCard = useCallback((canvas: HTMLCanvasElement): boolean => {
    if (!result) return false;
    canvas.width = 1080; canvas.height = 1350;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    const PAPER = '#ece9e2'; const MUTED = '#8f8e88'; const RED = '#ee553d';
    ctx.fillStyle = '#0c0c0b'; ctx.fillRect(0, 0, 1080, 1350);
    ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 2; ctx.strokeRect(33, 33, 1014, 1284);
    ctx.textBaseline = 'alphabetic';
    // Header: MOG / SCAN with a red slash, plus the edition tag.
    ctx.font = '900 40px "DM Sans", Arial, sans-serif';
    ctx.fillStyle = PAPER; ctx.fillText('MOG', 72, 118);
    const mogW = ctx.measureText('MOG').width;
    ctx.fillStyle = RED; ctx.fillText(' / ', 72 + mogW, 118);
    const slashW = ctx.measureText(' / ').width;
    ctx.fillStyle = PAPER; ctx.fillText('SCAN', 72 + mogW + slashW, 118);
    ctx.font = '500 19px "DM Mono", monospace'; ctx.fillStyle = RED;
    ctx.textAlign = 'right'; ctx.fillText('THE BLACK CAPSULE', 1008, 114); ctx.textAlign = 'left';
    ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(72, 150); ctx.lineTo(1008, 150); ctx.stroke();
    // Optional face photo (contain-fit, hairline framed).
    if (!faceFree && frameCanvasRef.current) {
      const frame = frameCanvasRef.current;
      const box = { x: 72, y: 186, w: 936, h: 560 };
      const s = Math.min(box.w / frame.width, box.h / frame.height);
      const w = frame.width * s; const h = frame.height * s;
      const px = box.x + (box.w - w) / 2; const py = box.y + (box.h - h) / 2;
      ctx.drawImage(frame, px, py, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 1; ctx.strokeRect(px, py, w, h);
    }
    // Score + /100 (Barlow Condensed, like the on-screen reveal).
    const baseY = faceFree ? 560 : 1010;
    ctx.font = '800 230px "Barlow Condensed", Impact, sans-serif'; ctx.fillStyle = PAPER;
    ctx.fillText(String(result.score), 68, baseY);
    const numW = ctx.measureText(String(result.score)).width;
    ctx.font = '500 66px "Barlow Condensed", Impact, sans-serif'; ctx.fillStyle = '#7d7d75';
    ctx.fillText('/100', 68 + numW + 14, baseY);
    // Tier chip.
    ctx.font = '500 26px "DM Mono", monospace';
    const tierText = result.tier; const tierW = ctx.measureText(tierText).width;
    ctx.strokeStyle = 'rgba(238,85,61,.4)'; ctx.lineWidth = 1.5; ctx.strokeRect(72, baseY + 30, tierW + 40, 58);
    ctx.fillStyle = RED; ctx.fillText(tierText, 92, baseY + 68);
    // Verdict headline (wrapped, up to two lines).
    ctx.font = '700 42px "DM Sans", Arial, sans-serif'; ctx.fillStyle = PAPER;
    const words = resultCopy[result.tier].headline.split(' ');
    const lines: string[] = []; let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > 936 && line) { lines.push(line); line = word; } else line = test;
    }
    if (line) lines.push(line);
    lines.slice(0, 2).forEach((text, i) => ctx.fillText(text, 72, baseY + 160 + i * 52));
    // Footer disclaimer.
    ctx.font = '400 21px "DM Mono", monospace'; ctx.fillStyle = MUTED;
    ctx.fillText('A model estimate. A roast. Not a measure of your worth.', 72, 1280);
    return true;
  }, [faceFree, result]);

  const downloadCard = useCallback(async () => {
    if (!result) return;
    await ensureCardFonts();
    const canvas = document.createElement('canvas');
    if (!renderCard(canvas)) return;
    const link = document.createElement('a'); link.download = 'mog-scan-result.png'; link.href = canvas.toDataURL('image/png'); link.click();
  }, [renderCard, result]);

  // Live card preview on the result screen (same renderer as the download, so
  // what's shown is exactly what saves). Re-renders when the face-free toggle flips.
  useEffect(() => {
    if (state !== 'result' || !result) { setCardPreview(null); return; }
    let cancelled = false;
    void (async () => {
      await ensureCardFonts();
      if (cancelled) return;
      const canvas = document.createElement('canvas');
      if (renderCard(canvas)) setCardPreview(canvas.toDataURL('image/png'));
    })();
    return () => { cancelled = true; };
  }, [state, result, faceFree, renderCard]);

  const saveLocal = useCallback(async (name: string): Promise<string | null> => {
    if (!result) return 'Nothing to save.';
    const prior = entries.find((entry) => entry.displayName.toLowerCase() === name.toLowerCase());
    if (prior && result.score <= prior.score) return 'This name already has an equal or higher score on this device.';
    if (prior && !window.confirm(`Replace ${prior.score} with ${result.score} on this device?`)) return 'Kept your existing score on this device.';
    const now = new Date().toISOString();
    const entry = { id: prior?.id ?? makeScanId(), displayName: name, score: result.score, tier: result.tier, modelVersion: result.modelVersion, createdAt: prior?.createdAt ?? now, updatedAt: now };
    try {
      const photo = await new Promise<Blob | null>((resolve) => frameCanvasRef.current?.toBlob(resolve, 'image/jpeg', .9));
      if (!photo) throw new Error();
      await saveLeaderboardPhoto(entry.id, photo);
      const next = rank([...entries.filter((item) => item !== prior), entry]);
      saveLeaderboard(next); setEntries(next);
      return null;
    } catch { return 'Local save failed.'; }
  }, [entries, result]);

  // Shared save sends only the server result ID; the service decides insert,
  // higher-score replacement (after confirmation), or unchanged.
  const saveToLeaderboard = useCallback(async (replace = false) => {
    if (!result) return;
    const name = normalizeName(displayName);
    if (name.length < 2 || name.length > 20) { setLeaderboardError('Use 2–20 characters.'); return; }
    setLeaderboardError('');
    if (!apiEnabled || !result.serverResultId) {
      const error = await saveLocal(name);
      if (error) setLeaderboardError(error); else { setSaveOpen(false); setDisplayName(''); }
      return;
    }
    setSaving(true);
    try {
      await ensureSession();
      const saved = await submitLeaderboard(result.serverResultId, name, replace);
      setConfirmReplace(null);
      setSharedSave(saved);
      if (keepLocal) { const localError = await saveLocal(name); if (localError) setLeaderboardError(localError); }
    } catch (error) {
      if (error instanceof ApiError && error.code === 'replace_confirmation_required' && error.details) setConfirmReplace(error.details as { currentScore: number; newScore: number });
      else setLeaderboardError(error instanceof ApiError ? error.message : 'Save failed. Try again.');
    } finally {
      setSaving(false);
    }
  }, [displayName, keepLocal, result, saveLocal]);

  const openShareForResult = useCallback(() => {
    if (!result?.serverResultId || !sharedSave) return;
    setShareSource({ resultId: result.serverResultId, displayName: sharedSave.entry.displayName, score: result.score, tier: result.tier, captureMode: result.captureMode, photoAvailable: false });
  }, [result, sharedSave]);

  // Navigating to a social route stops any camera/tracker work and the edit's
  // audio. A finished result stays in memory so Back returns to it.
  useEffect(() => {
    if (route.name === 'home') return;
    if (['permission', 'acquiring', 'sampling', 'paused', 'analyzing'].includes(stateRef.current) || duelRef.current) exitScanRef.current();
    setEditOpen(false); setLeaderboardOpen(false); setSaveOpen(false);
  }, [route]);

  const openMogEdit = useCallback(async () => {
    editUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    editUrlsRef.current = [];
    setEditFaces([]); setEditLoading(true); setEditOpen(true);
    const storedFaces = await Promise.all(loadLeaderboard().map(async (entry) => {
      try {
        const photo = await loadLeaderboardPhoto(entry.id);
        if (!photo) return null;
        const imageUrl = URL.createObjectURL(photo);
        editUrlsRef.current.push(imageUrl);
        const lowResolution = await new Promise<boolean | null>((resolve) => {
          const image = new Image();
          image.onload = () => resolve(Math.min(image.naturalWidth, image.naturalHeight) < 360);
          image.onerror = () => resolve(null);
          image.src = imageUrl;
        });
        if (lowResolution === null) { URL.revokeObjectURL(imageUrl); editUrlsRef.current = editUrlsRef.current.filter((url) => url !== imageUrl); return null; }
        return { ...entry, imageUrl, lowResolution };
      } catch { return null; }
    }));
    setEditFaces(storedFaces.filter((entry): entry is EditFace => entry !== null));
    setEditLoading(false);
  }, []);

  const active = ['permission', 'acquiring', 'sampling', 'paused'].includes(state);
  const tracking = state === 'acquiring' || state === 'sampling' || state === 'paused';
  const framesDone = Math.round((progress / 100) * REQUIRED_PREDICTIONS);
  const verdict = result ? resultCopy[result.tier] : null;
  // Only a result the service accepted onto the shared board (a publication) is shareable.
  const canShareResult = Boolean(apiEnabled && result?.serverResultId && sharedSave && sharedSave.entry.resultId === result.serverResultId && (sharedSave.outcome === 'inserted' || sharedSave.outcome === 'replaced' || sharedSave.outcome === 'unchanged') && !sharedSave.entry.postStatus);
  const duelFaces = duel?.phase === 'editing' && duel.first && duel.second ? [duel.first, duel.second] : editFaces;
  return <main className="app-shell">
    <header>
      <a className="brand" href="#/" onClick={(event) => { event.preventDefault(); exitScan(); navigate({ name: 'home' }); }}><i className="brand-capsule" />MOG<span>/</span>SCAN</a>
      <nav className="app-nav" aria-label="Main">
        {apiEnabled && <button className={`leaderboard-link${route.name === 'latest' || route.name === 'post' ? ' current' : ''}`} aria-current={route.name === 'latest' ? 'page' : undefined} onClick={() => navigate({ name: 'latest' })}>Latest</button>}
        <button className="leaderboard-link" onClick={() => { setEntries(loadLeaderboard()); setLeaderboardOpen(true); }}>Leaderboard</button>
        {apiEnabled && <button className="leaderboard-link" onClick={() => { navigate({ name: 'home' }); window.requestAnimationFrame(() => document.getElementById('duel-start')?.focus()); }}>1v1</button>}
        {apiEnabled && <button className={`leaderboard-link${route.name === 'my-mogs' || route.name === 'my-upmogs' ? ' current' : ''}`} aria-current={route.name === 'my-mogs' || route.name === 'my-upmogs' ? 'page' : undefined} onClick={() => navigate({ name: 'my-mogs' })}>My Mogs</button>}
        <button className="leaderboard-link" onClick={() => void openMogEdit()}>Who Mogs Who?</button>
      </nav>
      <span className="edition">THE BLACK CAPSULE <span>VOL. 001</span></span>
      <span className="status"><i className={tracking ? 'live' : ''} />{state === 'permission' ? 'AWAITING CAMERA' : tracking ? 'CAMERA ACTIVE' : 'CAMERA OFF'}</span>
    </header>
    {socialRoute && <section className="scan-card social-view">
      <div className="stage-label"><span>ANONYMOUS / NO LOGIN</span><span>{route.name === 'my-mogs' || route.name === 'my-upmogs' ? 'THIS BROWSER' : 'LATEST MOGS'}</span></div>
      <div className="social-body">
        {route.name === 'latest' && <><div className="social-heading"><p className="eyebrow"><span className="tiny-cross">✳</span> NEWEST FIRST · VOTES DON’T REORDER</p><h1>Latest <em>mogs.</em></h1></div><MogFeed kind="latest" onNavigate={navigate} /></>}
        {route.name === 'post' && <MogPostDetail key={route.id} id={route.id} onNavigate={navigate} />}
        {(route.name === 'my-mogs' || route.name === 'my-upmogs') && <><div className="social-heading"><h1>My <em>mogs.</em></h1></div><MyMogs tab={route.name} onNavigate={navigate} onShare={setShareSource} /></>}
      </div>
    </section>}
    {!socialRoute && <section className={`scan-card ${state}`}>
      <div className="stage-label"><span>UNFILTERED / UNSERIOUS</span><span>{state === 'idle' ? 'READY WHEN YOU ARE' : state === 'result' ? 'VERDICT DELIVERED' : 'LIVE SESSION'}</span></div>
      <div className="video-stage">
        {state === 'idle' && !duel && <div className="hero">
          <div className="hero-copy">
            <p className="eyebrow"><span className="tiny-cross">✳</span> A SMALL DOSE OF EGO CHECK</p>
            <h1>Take the<br /><em>black pill.</em></h1>
            <p className="hero-description">Three frames. One score. Zero glazing.<br />Your camera roll is about to get humbled.</p>
            <div className="hero-actions">
              <button className="primary start-button" onClick={() => void startCamera()}>Start scan <span aria-hidden="true">↗</span></button>
              <button id="duel-start" className="secondary upload-button" onClick={startLocalDuel}>1V1 MOG OFF <span aria-hidden="true">↗</span></button>
              <button className="secondary upload-button" onClick={() => uploadInputRef.current?.click()}>Upload a photo <span aria-hidden="true">↑</span></button>
            </div>
            <p className="consent-note">Camera starts on your say-so. Selected frames only. Uploads send just the cropped face.</p>
          </div>
          <BlackCapsule />
          <div className="hero-bottom"><span><b>01</b> FACE THE CAMERA</span><span><b>02</b> HOLD YOUR POSE</span><span><b>03</b> TAKE THE ROAST</span></div>
        </div>}
        {state === 'idle' && duel?.phase === 'handoff' && <div className="duel-panel">
          <p className="eyebrow"><span className="tiny-cross">✳</span> LOCAL 1V1 · NO SCORES YET</p>
          <h1>Player 1<br /><em>locked.</em></h1>
          <p className="hero-description">Pass the phone. Player 2 gets the same scan—then the edit decides it.</p>
          <div className="hero-actions"><button className="primary start-button" onClick={startSecondDuelScan}>Scan Player 2 <span aria-hidden="true">↗</span></button><button className="secondary upload-button" onClick={exitScan}>Cancel duel</button></div>
        </div>}
        {state !== 'idle' && state !== 'result' && state !== 'analyzing' && <>
          <video ref={videoRef} muted playsInline autoPlay />
          <canvas ref={overlayRef} className="landmark-overlay" />
          <div className="grid" />
          {state === 'sampling' && <div className="scanline" />}
          <div className="face-guide"><span /><span /><span /><span /></div>
          {tracking && <div className="hud">
            <div className="hud-win tl">
              <div className="hw-head"><span>◧ TRACKING</span><i className="dot" /></div>
              <div className="hw-row"><label>MODE</label><b>{state === 'sampling' ? 'SAMPLING' : state === 'paused' ? 'HOLD' : 'ACQUIRE'}</b></div>
              <div className="hw-row"><label>SUBJECTS</label><b>{hud.faces}</b></div>
              <div className="hw-row"><label>SIGNAL</label><b className={hud.eligible ? 'ok' : 'warn'}>{hud.eligible ? 'STABLE' : 'SEEKING'}</b></div>
            </div>
            <div className="hud-win bl">
              <div className="hw-head"><span>◧ ANALYSIS</span></div>
              <div className={`hw-note ${hud.eligible ? 'ok' : ''}`}>{hud.note}</div>
              <div className="hw-meter"><span style={{ width: `${progress}%` }} /></div>
              <div className="hw-row"><label>FRAMES</label><b>{framesDone}/{REQUIRED_PREDICTIONS}</b></div>
            </div>
            {hud.box && <div className="subject-tag" style={{ left: `${hud.box.l}%`, top: `${hud.box.t}%`, width: `${hud.box.w}%`, height: `${hud.box.h}%` }}>
              <span className="st-label">{hud.eligible ? '● LOCK' : '○ SEEK'}</span>
              <i /><i /><i /><i />
            </div>}
           </div>}
         </>}
        {state === 'result' && result && verdict && <div className="reveal">
          <p className="eyebrow">THE RESULTS ARE IN. BRACE YOURSELF.</p>
          <div className="score" aria-label={`${result.score} out of 100`}><span>{result.score}</span><small>/100</small></div>
          <div className="tier"><span className="tier-mark" />{result.tier}</div>
          <h2 className="verdict">{verdict.headline}</h2>
          <p className="verdict-detail">{verdict.detail}</p>
          <div className="actions"><button className="primary" onClick={scanAgain}>Run it back <span aria-hidden="true">↗</span></button><button className="secondary" onClick={() => { setLeaderboardError(''); if (!displayName && session.displayName) setDisplayName(session.displayName); setSaveOpen(true); }}>Save leaderboard</button>{canShareResult && <button className="secondary" onClick={openShareForResult}>Share as mog <span aria-hidden="true">↗</span></button>}</div>
          <section className="level-up">
            {tierPlaybooks.slice(Math.max(0, tierPlaybooks.findIndex((playbook) => playbook.tier === result.tier) + 1), Math.max(0, tierPlaybooks.findIndex((playbook) => playbook.tier === result.tier) + 2)).map((playbook) => <details key={playbook.tier}><summary>ASCENDING TO {playbook.tier} <span>+</span></summary><p>General style ideas, not an explanation of your score.</p><ol>{playbook.steps.map((step) => <li key={step}>{step}</li>)}</ol></details>)}
          </section>
          <section className="score-explainer">
            <details>
              <summary>HOW THIS SCORE IS CALCULATED <span>+</span></summary>
              <p>We select three steady, well-framed face crops. The model gives each crop a native score from 1 to 5; we use the middle score so one odd frame has less influence.</p>
              <p>That middle score is shown on a simple 0–100 scale with a small presentation boost: the linear value gets 10 points, capped at 100. It is not a percentile, diagnosis, or measurement of your worth.</p>
            </details>
          </section>
          <section className="receipt-block">
            <p className="eyebrow">YOUR RECEIPT</p>
            {cardPreview && <img className="receipt-preview" src={cardPreview} alt="Your MOG / SCAN result card" />}
            <label className="toggle"><input type="checkbox" checked={faceFree} onChange={(event) => setFaceFree(event.target.checked)} /> Keep my face off the card</label>
            <button className="secondary" onClick={() => void downloadCard()}>Save the receipt <span aria-hidden="true">↓</span></button>
          </section>
          <p className="result-disclaimer">A model estimate. A roast. Not a measure of your worth.</p>
        </div>}
        {state === 'analyzing' && <div className="analyzing-panel">
          <p className="eyebrow">READING THE ROOM</p>
          <BlackCapsule />
          <p role="status">{message}</p>
          <button className="text-button" onClick={exitScan}>Cancel</button>
        </div>}
        {state === 'error' && <div className="error-panel"><p className="eyebrow">TECHNICAL FOUL</p><h2>The scan flinched.</h2><p>{message}</p><button className="primary" onClick={() => void startCamera()}>Retry <span aria-hidden="true">↗</span></button><button className="secondary" onClick={() => uploadInputRef.current?.click()}>Upload a photo <span aria-hidden="true">↑</span></button><button className="text-button" onClick={exitScan}>Back home</button></div>}
        {introPlaying && <div key={introSequence} className="scan-intro" aria-hidden="true" onAnimationEnd={(event) => { if (event.target === event.currentTarget) setIntroPlaying(false); }}>
          <p className="eyebrow">BREAKING THE SEAL</p><BlackCapsule opening /><span className="intro-caption">EGO CHECK INCOMING.</span>
        </div>}
      </div>
      {active && <div className="scan-controls"><div className="progress-line" role="progressbar" aria-label="Scan progress" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress}%` }} /></div><p role="status">{message}</p><button className="exit" onClick={exitScan}>End scan</button></div>}
    </section>}
    {apiEnabled && !socialRoute && state === 'idle' && !duel && <section className="latest-home" aria-labelledby="latest-home-title">
      <div className="latest-home-head"><p className="eyebrow"><span className="tiny-cross">✳</span> FRESH FROM THE CAPSULE</p><h2 id="latest-home-title">Latest Mogs</h2><button className="text-button" onClick={() => navigate({ name: 'latest' })}>See all →</button></div>
      <MogFeed kind="latest" preview onNavigate={navigate} />
    </section>}
    <footer><span>THICK SKIN. GOOD LIGHTING.</span><span>FOR ENTERTAINMENT. NOT OBJECTIVE TRUTH.</span><span>MOG / SCAN © {new Date().getFullYear()}</span></footer>
    {saveOpen && result && <div className="modal"><div className="modal-card save-card">
      {apiEnabled && result.serverResultId ? (sharedSave ? <>
        <h2>{sharedSave.outcome === 'not_higher' ? 'Shared best unchanged' : 'Saved'}</h2>
        <p>{sharedSave.outcome === 'not_higher'
          ? `Your shared best is ${sharedSave.entry.score}. This scan stays off the shared leaderboard, so it can’t be posted as a mog.`
          : `You’re #${sharedSave.entry.rank} on the shared leaderboard as ${sharedSave.entry.displayName}.`}</p>
        {leaderboardError && <p className="mog-inline-error">{leaderboardError}</p>}
        <div className="actions">
          {canShareResult && <button className="primary" onClick={openShareForResult}>Share as mog <span aria-hidden="true">↗</span></button>}
          {sharedSave.entry.resultId === result.serverResultId && sharedSave.entry.postStatus === 'active' && sharedSave.entry.postId && <button className="primary" onClick={() => navigate({ name: 'post', id: sharedSave.entry.postId! })}>View mog</button>}
          <button className="secondary" onClick={() => setSaveOpen(false)}>Done</button>
        </div>
      </> : <>
        <h2>Save to leaderboard</h2>
        <p>Your name, score, tier, and date go on the shared leaderboard. No photo is uploaded. No account: this browser’s anonymous cookie is what lets you manage it.</p>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Display name" maxLength={20} disabled={saving || confirmReplace !== null} />
        <label className="toggle save-local"><input type="checkbox" checked={keepLocal} onChange={(event) => setKeepLocal(event.target.checked)} /> Also keep it on this device, with this scan photo, for Who Mogs Who?</label>
        {confirmReplace && <p className="replace-prompt">Replace your shared {confirmReplace.currentScore} with {confirmReplace.newScore}?</p>}
        {leaderboardError && <p className="mog-inline-error">{leaderboardError}</p>}
        <div className="actions">{confirmReplace
          ? <><button className="primary" disabled={saving} onClick={() => void saveToLeaderboard(true)}>Replace</button><button className="secondary" disabled={saving} onClick={() => setConfirmReplace(null)}>Keep old score</button></>
          : <><button className="primary" disabled={saving} onClick={() => void saveToLeaderboard()}>{saving ? 'Saving…' : 'Save'}</button><button className="secondary" disabled={saving} onClick={() => setSaveOpen(false)}>Cancel</button></>}</div>
      </>) : <>
        <h2>Save locally</h2><p>Your name, score, tier, date, and this scan photo save in this browser. The photo is only used for local Who Mogs Who? playback.</p>
        {apiEnabled && <p className="social-note">This scan wasn’t recorded by the server (cookies blocked, offline, or a local 1v1), so it can only be saved on this device and can’t be posted.</p>}
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Display name" maxLength={20} />{leaderboardError && <p>{leaderboardError}</p>}<div className="actions"><button className="primary" onClick={() => void saveToLeaderboard()}>Save</button><button className="secondary" onClick={() => setSaveOpen(false)}>Cancel</button></div>
      </>}
    </div></div>}
    {leaderboardOpen && <div className="modal"><div className="modal-card leaderboard">{apiEnabled && <div className="social-tabs small" role="tablist" aria-label="Leaderboard">
      <button type="button" role="tab" aria-selected={leaderboardTab === 'shared'} className={leaderboardTab === 'shared' ? 'active' : ''} onClick={() => setLeaderboardTab('shared')}>Shared</button>
      <button type="button" role="tab" aria-selected={leaderboardTab === 'local'} className={leaderboardTab === 'local' ? 'active' : ''} onClick={() => setLeaderboardTab('local')}>This device</button>
    </div>}{apiEnabled && leaderboardTab === 'shared' ? <><h2>Shared leaderboard</h2><SharedLeaderboard onShare={(source) => { setShareSource(source); }} onOpenPost={(postId) => navigate({ name: 'post', id: postId })} onOpenLatest={() => navigate({ name: 'latest' })} /><div className="actions leaderboard-actions"><button className="primary" onClick={() => setLeaderboardOpen(false)}>Done</button></div></> : <><h2>{apiEnabled ? 'This device' : 'Local leaderboard'}</h2>{entries.length ? <ol>{entries.map((entry, i) => <li key={entry.id}><span>#{i + 1} {entry.displayName}</span><b>{entry.score} · {entry.tier}</b><button className="text-button" onClick={() => { const next = entries.filter((item) => item.id !== entry.id); saveLeaderboard(next); setEntries(next); void deleteLeaderboardPhoto(entry.id); }}>Delete</button></li>)}</ol> : <p>No saved scores.</p>}<div className="actions leaderboard-actions"><button className="secondary" onClick={() => { setLeaderboardOpen(false); void openMogEdit(); }}>Who Mogs Who?</button><button className="secondary" onClick={() => { if (window.confirm('Clear local records and photos?')) { clearLeaderboard(); void clearLeaderboardPhotos(); setEntries([]); } }}>Clear all</button><button className="primary" onClick={() => setLeaderboardOpen(false)}>Done</button></div></>}</div></div>}
    {shareSource && <ShareMogSheet key={shareSource.resultId} source={shareSource} onClose={() => setShareSource(null)} onOpenPost={(postId) => { setShareSource(null); setSaveOpen(false); navigate({ name: 'post', id: postId }); }} onPosted={(post) => {
      setShareSource(null); setSaveOpen(false); setLeaderboardOpen(false);
      setSharedSave((current) => (current && current.entry.resultId === shareSource.resultId ? { ...current, entry: { ...current.entry, postId: post.id, postStatus: 'active' } } : current));
      navigate({ name: 'post', id: post.id });
    }} />}
    {editOpen && <MogEdit faces={duelFaces} loading={editLoading} fixedParticipants={duel?.phase === 'editing'} onClose={() => { setEditOpen(false); if (duelRef.current?.phase === 'editing') clearDuel(); }} />}
    <canvas ref={frameCanvasRef} className="hidden" /><canvas ref={qualityCanvasRef} className="hidden" />
    <input ref={uploadInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void scanImage(file); }} />
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
