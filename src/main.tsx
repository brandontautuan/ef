import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { BlackCapsule } from './components/BlackCapsule';
import { resultCopy } from './resultCopy';
import './styles.css';

type ScanState = 'idle' | 'permission' | 'acquiring' | 'sampling' | 'paused' | 'result' | 'error';
type QualityFailure = 'no_face' | 'multiple_faces' | 'too_small' | 'cut_off' | 'pose' | 'dark' | 'blur' | 'motion';
type QualityAssessment = { eligible: boolean; failures: QualityFailure[] };
type Prediction = { nativeScore: number; modelVersion: string; sequence: number };

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

function makeScanId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Heuristic display calibration. With the face-crop fix, real-face native scores
// from this model land around ~3.0-3.2 (measured on a live face at normal/close
// distance), so we center the display band on 3.1 -> 50 with a span of 1.6, i.e.
// map native [2.3, 3.9] across 0-100. That puts a typical face mid-scale (MTN)
// with headroom above/below for genuine variation. Still an unvalidated stand-in
// tuned to one tester — replace with a data-driven percentile calibration
// (measured over a consented set) before any real launch.
const DISPLAY_NATIVE_MIN = 2.3;
const DISPLAY_NATIVE_MAX = 3.9;

function displayScore(nativeScore: number) {
  const span = DISPLAY_NATIVE_MAX - DISPLAY_NATIVE_MIN;
  return Math.round(Math.min(100, Math.max(0, ((nativeScore - DISPLAY_NATIVE_MIN) / span) * 100)));
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
  const previousFaceCenterRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const validSinceRef = useRef<number | null>(null);
  const [state, setState] = useState<ScanState>('idle');
  const [message, setMessage] = useState('Camera stays off until you start.');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ score: number; tier: string; modelVersion: string; nativeScores: number[]; medianNativeScore: number } | null>(null);
  const [faceFree, setFaceFree] = useState(false);
  const [introPlaying, setIntroPlaying] = useState(false);
  const [introSequence, setIntroSequence] = useState(0);
  const [hud, setHud] = useState<{ faces: number; box: { l: number; t: number; w: number; h: number } | null; eligible: boolean; note: string }>({ faces: 0, box: null, eligible: false, note: 'INITIALIZING' });

  useEffect(() => { stateRef.current = state; }, [state]);

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
    setProgress(0);
    setResult(null);
  }, [clearScanTimers]);

  useEffect(() => () => { activeScanId.current = makeScanId(); clearScanTimers(); stopTracking(); stopCamera(); }, [clearScanTimers, stopCamera, stopTracking]);

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
    const vw = video.videoWidth; const vh = video.videoHeight;
    if (vw === 0 || vh === 0) return false;
    canvas.width = 640;
    canvas.height = 640;
    const context = canvas.getContext('2d');
    if (!context) return false;
    // Crop to the detected face (not a fixed center square), so the model sees a
    // consistently framed face regardless of distance. A whole-frame crop made the
    // score track how much of the frame the face filled — far away read as 0.
    const face = facesRef.current[0];
    let sx: number; let sy: number; let sSide: number;
    if (face && face.length) {
      const xs = face.map((p) => p.x); const ys = face.map((p) => p.y);
      const left = Math.min(...xs) * vw; const right = Math.max(...xs) * vw;
      const top = Math.min(...ys) * vh; const bottom = Math.max(...ys) * vh;
      const cx = (left + right) / 2; const cy = (top + bottom) / 2;
      // Expand the tight landmark box to include forehead/jaw/margin, then square it.
      const FACE_MARGIN = 0.5;
      const boxSide = Math.max(right - left, bottom - top) * (1 + FACE_MARGIN);
      sSide = Math.min(boxSide, vw, vh); // never exceed the frame
      sx = Math.min(Math.max(cx - sSide / 2, 0), vw - sSide);
      sy = Math.min(Math.max(cy - sSide / 2, 0), vh - sSide);
    } else {
      // Fallback (no face): centered square, as before.
      sSide = Math.min(vw, vh);
      sx = (vw - sSide) / 2;
      sy = (vh - sSide) / 2;
    }
    context.drawImage(video, sx, sy, sSide, sSide, 0, 0, 640, 640);
    return true;
  }, []);

  const finish = useCallback((items: Prediction[]) => {
    clearScanTimers();
    const modelVersion = items[0].modelVersion;
    if (items.some((item) => item.modelVersion !== modelVersion)) {
      setState('error');
      setMessage('The model changed during this scan. Please scan again.');
      return;
    }
    const nativeScores = items.map((item) => item.nativeScore);
    const medianNativeScore = median(nativeScores);
    const score = displayScore(medianNativeScore);
    scanDebug('result_locked', {
      frames: items.length,
      nativeScores: nativeScores.map((value) => Number(value.toFixed(3))),
      aggregation: 'median',
      medianNativeScore: Number(medianNativeScore.toFixed(3)),
      displayFormula: 'clamp(round(((native - 2.3) / 1.6) * 100), 0, 100)',
      displayScore: score,
      tier: tierFor(score),
      modelVersion,
    });
    setResult({ score, tier: tierFor(score), modelVersion, nativeScores, medianNativeScore });
    setState('result');
    setMessage('Result locked from this scan.');
  }, [clearScanTimers]);

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
      const prediction = await scoreFrame(frameCanvasRef.current!, scanId, frameSequence);
      if (scanId !== activeScanId.current || (stateRef.current !== 'sampling' && stateRef.current !== 'paused')) return;
      const next = [...predictions.current, prediction];
      predictions.current = next;
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
      if (next.length >= REQUIRED_PREDICTIONS) finish(next);
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

  const scanAgain = useCallback(() => { stopTracking(); stopCamera(); void startCamera(); }, [startCamera, stopCamera, stopTracking]);
  const exitScan = useCallback(() => {
    setIntroPlaying(false);
    activeScanId.current = makeScanId();
    clearScanTimers(); stopTracking(); stopCamera(); stateRef.current = 'idle'; setState('idle'); setMessage('Camera stays off until you start.'); setProgress(0); setResult(null);
  }, [clearScanTimers, stopCamera, stopTracking]);

  const downloadCard = useCallback(() => {
    if (!result) return;
    const canvas = document.createElement('canvas');
    canvas.width = 1080; canvas.height = 1350;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.fillStyle = '#090909'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#343434'; context.strokeRect(35, 35, 1010, 1280);
    context.fillStyle = '#ece9e2'; context.font = '900 42px Arial'; context.fillText('MOG / SCAN', 72, 112);
    context.fillStyle = '#ee553d'; context.font = '20px monospace'; context.fillText('THE BLACK CAPSULE', 720, 108);
    if (!faceFree && frameCanvasRef.current) context.drawImage(frameCanvasRef.current, 0, 115, 640, 410, 72, 165, 936, 600);
    const scoreY = faceFree ? 640 : 1000;
    context.fillStyle = '#ece9e2'; context.font = '900 220px Arial'; context.fillText(String(result.score), 65, scoreY);
    const scoreWidth = context.measureText(String(result.score)).width;
    context.fillStyle = '#92908b'; context.font = '500 70px Arial'; context.fillText('/100', 82 + scoreWidth, scoreY);
    context.fillStyle = '#ee553d'; context.font = '800 40px Arial'; context.fillText(result.tier, 75, scoreY + 65);
    context.fillStyle = '#ece9e2'; context.font = '700 40px Arial'; context.fillText(resultCopy[result.tier].headline, 75, scoreY + 140, 930);
    context.fillStyle = '#92908b'; context.font = '22px Arial'; context.fillText('A model estimate. A roast. Not a measure of your worth.', 75, 1265);
    const link = document.createElement('a'); link.download = 'mog-scan-result.png'; link.href = canvas.toDataURL('image/png'); link.click();
  }, [faceFree, result]);

  const active = ['permission', 'acquiring', 'sampling', 'paused'].includes(state);
  const tracking = state === 'acquiring' || state === 'sampling' || state === 'paused';
  const framesDone = Math.round((progress / 100) * REQUIRED_PREDICTIONS);
  const verdict = result ? resultCopy[result.tier] : null;
  return <main className="app-shell">
    <header>
      <a className="brand" href="#top" onClick={exitScan}><i className="brand-capsule" />MOG<span>/</span>SCAN</a>
      <span className="edition">THE BLACK CAPSULE <span>VOL. 001</span></span>
      <span className="status"><i className={tracking ? 'live' : ''} />{state === 'permission' ? 'AWAITING CAMERA' : tracking ? 'CAMERA ACTIVE' : 'CAMERA OFF'}</span>
    </header>
    <section className={`scan-card ${state}`}>
      <div className="stage-label"><span>UNFILTERED / UNSERIOUS</span><span>{state === 'idle' ? 'READY WHEN YOU ARE' : state === 'result' ? 'VERDICT DELIVERED' : 'LIVE SESSION'}</span></div>
      <div className="video-stage">
        {state === 'idle' && <div className="hero">
          <div className="hero-copy">
            <p className="eyebrow"><span className="tiny-cross">✳</span> A SMALL DOSE OF EGO CHECK</p>
            <h1>Take the<br /><em>black pill.</em></h1>
            <p className="hero-description">Three frames. One score. Zero glazing.<br />Your camera roll is about to get humbled.</p>
            <button className="primary start-button" onClick={() => void startCamera()}>Start scan <span aria-hidden="true">↗</span></button>
            <p className="consent-note">Camera starts on your say-so. Selected frames only.</p>
          </div>
          <BlackCapsule />
          <div className="hero-bottom"><span><b>01</b> FACE THE CAMERA</span><span><b>02</b> HOLD YOUR POSE</span><span><b>03</b> TAKE THE ROAST</span></div>
        </div>}
        {state !== 'idle' && state !== 'result' && <>
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
          <div className="actions"><button className="primary" onClick={scanAgain}>Run it back <span aria-hidden="true">↗</span></button><button className="secondary" onClick={downloadCard}>Save the receipt <span aria-hidden="true">↓</span></button></div>
          <label className="toggle"><input type="checkbox" checked={faceFree} onChange={(event) => setFaceFree(event.target.checked)} /> Keep my face off the card</label>
          <section className="level-up">
            {tierPlaybooks.slice(Math.max(0, tierPlaybooks.findIndex((playbook) => playbook.tier === result.tier) + 1), Math.max(0, tierPlaybooks.findIndex((playbook) => playbook.tier === result.tier) + 2)).map((playbook) => <details key={playbook.tier}><summary>Your next move <span>+</span></summary><p>General style ideas, not an explanation of your score.</p><ol>{playbook.steps.map((step) => <li key={step}>{step}</li>)}</ol></details>)}
          </section>
          {scanDebugEnabled && <details className="diagnostics"><summary>How this result was calculated</summary><div><span>Valid frames</span><b>{result.nativeScores.map((value) => value.toFixed(3)).join(' · ')}</b></div><div><span>Aggregation</span><b>Median: {result.medianNativeScore.toFixed(3)} / 5</b></div><div><span>Display map</span><b>((native − 2.3) ÷ 1.6) × 100</b></div><div><span>Model</span><b>{result.modelVersion}</b></div></details>}
          <p className="result-disclaimer">A model estimate. A roast. Not a measure of your worth.</p>
        </div>}
        {state === 'error' && <div className="error-panel"><p className="eyebrow">TECHNICAL FOUL</p><h2>The scan flinched.</h2><p>{message}</p><button className="primary" onClick={() => void startCamera()}>Retry <span aria-hidden="true">↗</span></button><button className="text-button" onClick={exitScan}>Back home</button></div>}
        {introPlaying && <div key={introSequence} className="scan-intro" aria-hidden="true" onAnimationEnd={(event) => { if (event.target === event.currentTarget) setIntroPlaying(false); }}>
          <p className="eyebrow">BREAKING THE SEAL</p><BlackCapsule opening /><span className="intro-caption">EGO CHECK INCOMING.</span>
        </div>}
      </div>
      {active && <div className="scan-controls"><div className="progress-line" role="progressbar" aria-label="Scan progress" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress}%` }} /></div><p role="status">{message}</p><button className="exit" onClick={exitScan}>End scan</button></div>}
    </section>
    <footer><span>THICK SKIN. GOOD LIGHTING.</span><span>FOR ENTERTAINMENT. NOT OBJECTIVE TRUTH.</span><span>MOG / SCAN © {new Date().getFullYear()}</span></footer>
    <canvas ref={frameCanvasRef} className="hidden" /><canvas ref={qualityCanvasRef} className="hidden" />
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
