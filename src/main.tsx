import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import './styles.css';

type ScanState = 'idle' | 'permission' | 'acquiring' | 'sampling' | 'paused' | 'result' | 'error';
type QualityFailure = 'no_face' | 'multiple_faces' | 'too_small' | 'cut_off' | 'pose' | 'dark' | 'blur' | 'motion';
type QualityAssessment = { eligible: boolean; failures: QualityFailure[] };
type Prediction = { nativeScore: number; modelVersion: string; sequence: number };

const SCAN_TIMEOUT_MS = 28_000;
const SAMPLE_INTERVAL_MS = 1_100;
const REQUIRED_PREDICTIONS = 3;
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

function makeScanId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function displayScore(nativeScore: number) {
  return Math.round(Math.min(100, Math.max(0, ((nativeScore - 1) / 4) * 100)));
}

function tierFor(score: number) {
  if (score >= 86) return 'ICONIC';
  if (score >= 70) return 'ELECTRIC';
  if (score >= 52) return 'LOCKED IN';
  return 'ON THE RISE';
}

function isMediaSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia);
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
  const overallTimer = useRef<number | null>(null);
  const requestInFlight = useRef(false);
  const sequence = useRef(0);
  const predictions = useRef<Prediction[]>([]);
  const stateRef = useRef<ScanState>('idle');
  const trackerRef = useRef<FaceLandmarker | null>(null);
  const trackingFrame = useRef<number | null>(null);
  const facesRef = useRef<Array<Array<{ x: number; y: number }>>>([]);
  const [state, setState] = useState<ScanState>('idle');
  const [message, setMessage] = useState('Camera stays off until you start.');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ score: number; tier: string; modelVersion: string } | null>(null);
  const [faceFree, setFaceFree] = useState(false);

  useEffect(() => { stateRef.current = state; }, [state]);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const clearScanTimers = useCallback(() => {
    if (samplingTimer.current) window.clearInterval(samplingTimer.current);
    if (overallTimer.current) window.clearTimeout(overallTimer.current);
    samplingTimer.current = null;
    overallTimer.current = null;
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
    setProgress(0);
    setResult(null);
  }, [clearScanTimers]);

  useEffect(() => () => { clearScanTimers(); stopTracking(); stopCamera(); }, [clearScanTimers, stopCamera, stopTracking]);

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
    return { eligible: true, failures: [] };
  }, []);

  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = frameCanvasRef.current;
    if (!video || !canvas) return false;
    const side = Math.min(video.videoWidth, video.videoHeight);
    canvas.width = 640;
    canvas.height = 640;
    const context = canvas.getContext('2d');
    if (!context) return false;
    const sourceX = Math.max(0, (video.videoWidth - side) / 2);
    const sourceY = Math.max(0, (video.videoHeight - side) / 2);
    context.drawImage(video, sourceX, sourceY, side, side, 0, 0, 640, 640);
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
    const score = displayScore(median(items.map((item) => item.nativeScore)));
    setResult({ score, tier: tierFor(score), modelVersion });
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
    if (!captureFrame()) return;
    requestInFlight.current = true;
    const scanId = activeScanId.current;
    const frameSequence = ++sequence.current;
    try {
      const prediction = await scoreFrame(frameCanvasRef.current!, scanId, frameSequence);
      if (scanId !== activeScanId.current || (stateRef.current !== 'sampling' && stateRef.current !== 'paused')) return;
      const next = [...predictions.current, prediction];
      predictions.current = next;
      setProgress(Math.round((next.length / REQUIRED_PREDICTIONS) * 100));
      setMessage(next.length === REQUIRED_PREDICTIONS - 1 ? 'One more frame…' : 'Hold that pose…');
      if (next.length >= REQUIRED_PREDICTIONS) finish(next);
    } catch (error) {
      if (scanId === activeScanId.current) {
        clearScanTimers();
        setState('error');
        setMessage(error instanceof Error ? error.message : 'Scoring failed. Please retry.');
      }
    } finally {
      requestInFlight.current = false;
    }
  }, [assessFrame, captureFrame, clearScanTimers, finish]);

  const beginSampling = useCallback(() => {
    stateRef.current = 'sampling';
    setState('sampling');
    setMessage('Hold that pose…');
    window.setTimeout(() => void sample(), 250);
    samplingTimer.current = window.setInterval(() => void sample(), SAMPLE_INTERVAL_MS);
  }, [sample]);

  const initializeTracker = useCallback(async () => {
    const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm');
    const tracker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task' },
      runningMode: 'VIDEO',
      numFaces: 2,
    });
    trackerRef.current = tracker;
    const detect = () => {
      const video = videoRef.current;
      if (!video || !trackerRef.current || !streamRef.current) return;
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        const detection = trackerRef.current.detectForVideo(video, performance.now());
        facesRef.current = detection.faceLandmarks.map((face) => face.map(({ x, y }) => ({ x, y })));
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
    resetScan();
    setState('permission');
    setMessage('Allow camera access to begin your live scan.');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      await initializeTracker();
      setState('acquiring');
      setMessage('Center your face in the frame');
      window.setTimeout(beginSampling, 800);
      overallTimer.current = window.setTimeout(() => {
        clearScanTimers();
        setState('error');
        setMessage('The scan timed out. Try again in brighter, steadier light.');
      }, SCAN_TIMEOUT_MS);
    } catch {
      stopTracking();
      stopCamera();
      setState('error');
      setMessage('Camera access was not granted. Enable it in browser settings, then retry.');
    }
  }, [beginSampling, clearScanTimers, initializeTracker, resetScan, stopCamera, stopTracking]);

  const scanAgain = useCallback(() => { stopTracking(); stopCamera(); void startCamera(); }, [startCamera, stopCamera, stopTracking]);
  const exitScan = useCallback(() => {
    clearScanTimers(); stopTracking(); stopCamera(); stateRef.current = 'idle'; setState('idle'); setMessage('Camera stays off until you start.'); setProgress(0); setResult(null);
  }, [clearScanTimers, stopCamera, stopTracking]);

  const downloadCard = useCallback(() => {
    if (!result) return;
    const canvas = document.createElement('canvas');
    canvas.width = 1080; canvas.height = 1350;
    const context = canvas.getContext('2d');
    if (!context) return;
    const gradient = context.createLinearGradient(0, 0, 1080, 1350);
    gradient.addColorStop(0, '#ef5a37'); gradient.addColorStop(0.45, '#d7ff36'); gradient.addColorStop(1, '#5c41f0');
    context.fillStyle = gradient; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#080a12'; context.font = '800 48px Arial'; context.fillText('MOG / LIVE SCAN', 72, 100);
    if (!faceFree && frameCanvasRef.current) context.drawImage(frameCanvasRef.current, 72, 180, 936, 720);
    context.fillStyle = '#080a12'; context.font = '900 220px Arial'; context.fillText(String(result.score), 70, faceFree ? 650 : 1130);
    context.font = '800 54px Arial'; context.fillText(result.tier, 75, faceFree ? 730 : 1215);
    context.font = '500 25px Arial'; context.fillText('A model estimate from this scan — for entertainment.', 75, 1285);
    const link = document.createElement('a'); link.download = 'mog-scan-result.png'; link.href = canvas.toDataURL('image/png'); link.click();
  }, [faceFree, result]);

  const active = ['permission', 'acquiring', 'sampling', 'paused'].includes(state);
  return <main className="app-shell">
    <header><a className="brand" href="#top" onClick={exitScan}>MOG<span>/</span>SCAN</a><span className="status"><i className={active ? 'live' : ''} />{active ? 'CAMERA ACTIVE' : 'CAMERA OFF'}</span></header>
    <section className={`scan-card ${state}`}>
      <div className="video-stage">
        {state === 'idle' && <div className="hero"><p className="eyebrow">LIVE CAMERA EXPERIENCE</p><h1>Find your<br /><em>frame.</em></h1><p>Three steady moments. One model estimate. No uploads until your scan starts.</p><button className="primary" onClick={() => void startCamera()}>Start scan <b>↗</b></button></div>}
        {state !== 'idle' && state !== 'result' && <><video ref={videoRef} muted playsInline autoPlay /><div className="grid" /><div className="face-guide"><span /><span /><span /><span /></div></>}
        {state === 'result' && result && <div className="reveal"><p className="eyebrow">SCAN COMPLETE</p><div className="score">{result.score}</div><div className="tier">{result.tier}</div><p>Model estimate from this scan.<br />Not an objective measure of attractiveness.</p><div className="actions"><button className="primary" onClick={scanAgain}>Scan again <b>↗</b></button><button className="secondary" onClick={downloadCard}>Save card</button></div><label className="toggle"><input type="checkbox" checked={faceFree} onChange={(event) => setFaceFree(event.target.checked)} /> Face-free card</label></div>}
        {state === 'error' && <div className="error-panel"><p className="eyebrow">SCAN PAUSED</p><h2>Let’s try that again.</h2><p>{message}</p><button className="primary" onClick={() => void startCamera()}>Retry <b>↗</b></button><button className="text-button" onClick={exitScan}>Back home</button></div>}
      </div>
      {active && <div className="scan-controls"><div className="progress-line"><span style={{ width: `${progress}%` }} /></div><p>{message}</p><button className="exit" onClick={exitScan}>End scan</button></div>}
    </section>
    <footer><span>PRIVATE BY DEFAULT</span><span>SELECTED FRAMES ONLY</span><span>NO SAVED SCANS</span></footer>
    <canvas ref={frameCanvasRef} className="hidden" />
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
