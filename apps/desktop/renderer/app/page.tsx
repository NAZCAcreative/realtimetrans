"use client";

import React, { useEffect, useRef, useState } from "react";
import { useSubtitleStore } from "../stores/subtitleStore";
import {
  Activity,
  Captions,
  FileText,
  Globe,
  History,
  Languages,
  List,
  MonitorUp,
  Moon,
  Play,
  RotateCcw,
  Sliders,
  Square,
  Trash2,
  Sun,
  Tv,
} from "lucide-react";

const resolveApiHost = () => {
  if (process.env.NEXT_PUBLIC_API_HOST) {
    return process.env.NEXT_PUBLIC_API_HOST;
  }

  if (typeof window === "undefined") {
    return "127.0.0.1:8012";
  }

  const { hostname, host, protocol } = window.location;
  if (hostname && hostname !== "localhost" && hostname !== "127.0.0.1") {
    return protocol === "https:" ? host : `${hostname}:8012`;
  }

  return "127.0.0.1:8012";
};

const API_HOST = resolveApiHost();
const API_PROTOCOL = typeof window !== "undefined" && window.location.protocol === "https:" ? "https" : "http";
const WS_PROTOCOL = API_PROTOCOL === "https" ? "wss" : "ws";
const HTTP_API_BASE = `${API_PROTOCOL}://${API_HOST}`;
const WS_API_BASE = `${WS_PROTOCOL}://${API_HOST}`;
const SEGMENT_MS = 1000;
const APP_BUILD_VERSION = "Patch v2026.07.08.1145";

// STT providers that receive a continuous raw-PCM stream (vs chunked WAV/webm),
// mapped to their required input sample rate in Hz.
const PCM_STREAMING_PROVIDERS: Record<string, number> = {
  openai_realtime: 24000,
  openai_realtime_translate: 24000,
  gemini_live: 16000,
};
const isPcmStreaming = (provider: string) => provider in PCM_STREAMING_PROVIDERS;
const pcmRate = (provider: string) => PCM_STREAMING_PROVIDERS[provider] ?? 16000;


type CaptureStatus = "idle" | "selecting" | "capturing" | "error";
type CaptureMode = "system" | "window" | "microphone";
type SelectedCaptureMode = CaptureMode | null;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}


function downsampleBuffer(buffer: Float32Array, inputRate: number, outputRate: number) {
  if (outputRate === inputRate) {
    return buffer;
  }

  const ratio = inputRate / outputRate;
  const length = Math.floor(buffer.length / ratio);
  const result = new Float32Array(length);

  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), buffer.length);
    let sum = 0;
    for (let j = start; j < end; j += 1) {
      sum += buffer[j];
    }
    result[i] = sum / Math.max(1, end - start);
  }

  return result;
}

function pcm16Base64(samples: Float32Array) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);

  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}
// Keep the live Original readable: show only the tail of long growing turns.
function tailText(text: string, max = 1200) {
  return text.length > max ? "..." + text.slice(-max) : text;
}

function getRecorderMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

export default function Dashboard() {
  const {
    isCapturing,
    isConnected,
    sttProvider,
    translationProvider,
    sourceLanguage,
    targetLanguage,
    partialTranscript,
    finalTranscript,
    translatedText,
    sessions,
    activeSessionId,
    selectedSessionId,
    resetOnNewCapture,
    setCapturing,
    setConnected,
    setProviders,
    setLanguages,
    setResetOnNewCapture,
    startSession,
    selectSession,
    updatePartial,
    commitFinalTranscript,
    clearLiveTranscript,
    commitTranslation,
    clearHistory,
  } = useSubtitleStore();

  const selectedSession = sessions.find((s) => s.id === selectedSessionId) ?? sessions[0] ?? null;
  const sessionItems = selectedSession?.items ?? [];
  const visibleSessions = sessions.slice(0, 3);
  const hiddenSessionCount = Math.max(0, sessions.length - visibleSessions.length);

  const [overlayActive, setOverlayActive] = useState(false);
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("Ready");
  const [captureMode, setCaptureMode] = useState<SelectedCaptureMode>(null);
  const [backendAvailable, setBackendAvailable] = useState(false);
  const [liveAudioNotice, setLiveAudioNotice] = useState("");
  const [livePartialTranslation, setLivePartialTranslation] = useState("");
  const [recentTranslations, setRecentTranslations] = useState<{ id: string; text: string }[]>([]);
  const [logView, setLogView] = useState<"both" | "original" | "translation">("both");
  const [translationLatencyMs, setTranslationLatencyMs] = useState<number | null>(null);
  const [windowCaptureAvailable, setWindowCaptureAvailable] = useState(true);
  const [microphoneCaptureAvailable, setMicrophoneCaptureAvailable] = useState(true);
  const [systemCaptureAvailable, setSystemCaptureAvailable] = useState(true);
  const [isLightTheme, setIsLightTheme] = useState(false);

  // The live Translation shows a short rolling window of recent sentences (older
  // ones dimmed) plus the in-progress one, so it reads as a real-time stream. Stable
  // per-sentence keys let only newly added sentences fade in.
  const translationLines: { key: string; text: string; isPartial: boolean }[] = [
    ...recentTranslations
      .slice(livePartialTranslation ? -2 : -3)
      .map((t) => ({ key: t.id, text: t.text, isPartial: false })),
    ...(livePartialTranslation ? [{ key: "partial", text: livePartialTranslation, isPartial: true }] : []),
  ];

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const segmentTimerRef = useRef<NodeJS.Timeout | null>(null);
  const activeRef = useRef(false);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const lastTranscriptFinalAtRef = useRef<number | null>(null);
  const captureModeRef = useRef<CaptureMode>("window");

  const pushOverlay = (data: any) => {
    if (typeof window !== "undefined" && (window as any).electronAPI) {
      (window as any).electronAPI.updateSubtitles(data);
    }
  };

  useEffect(() => {
    if (!finalTranscript || partialTranscript) {
      return;
    }

    const timer = window.setTimeout(() => {
      clearLiveTranscript();
    }, 3000);

    return () => window.clearTimeout(timer);
  }, [clearLiveTranscript, finalTranscript, partialTranscript]);

  // Normalize provider selections that were persisted before an option was removed
  // (e.g. Gemini translation, Local Whisper) so a stale value can't silently break.
  useEffect(() => {
    const validStt = ["openai_realtime_translate", "openai_realtime", "gemini_live"];
    const validTrans = ["facebook_nllb", "openai", "gemini"];
    const nextStt = validStt.includes(sttProvider) ? sttProvider : "openai_realtime_translate";
    const nextTrans = validTrans.includes(translationProvider) ? translationProvider : "facebook_nllb";
    if (nextStt !== sttProvider || nextTrans !== translationProvider) {
      setProviders(nextStt, nextTrans);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const hasWindow = typeof window !== "undefined";
    const hasMediaDevices = hasWindow && Boolean(navigator.mediaDevices);
    const isSecure = hasWindow && window.isSecureContext;
    const isLocalHost = hasWindow && ["localhost", "127.0.0.1"].includes(window.location.hostname);
    const hasElectron = hasWindow && Boolean((window as any).electronAPI);
    setWindowCaptureAvailable(isSecure && hasMediaDevices && Boolean(navigator.mediaDevices?.getDisplayMedia));
    setMicrophoneCaptureAvailable(isSecure && hasMediaDevices && Boolean(navigator.mediaDevices?.getUserMedia));
    setSystemCaptureAvailable(hasElectron || isLocalHost);
  }, []);

  useEffect(() => {
    let mounted = true;

    const checkBackend = async () => {
      try {
        const response = await fetch(`${HTTP_API_BASE}/health`, { cache: "no-store" });
        if (mounted) {
          setBackendAvailable(response.ok);
        }
      } catch {
        if (mounted) {
          setBackendAvailable(false);
        }
      }
    };

    void checkBackend();
    const interval = window.setInterval(checkBackend, 5000);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, []);
  const scheduleReconnect = () => {
    // Only reconnect while the user still intends to be capturing.
    if (!activeRef.current || reconnectTimerRef.current) {
      return;
    }
    const attempt = reconnectAttemptsRef.current + 1;
    reconnectAttemptsRef.current = attempt;
    const delay = Math.min(1000 * 2 ** (attempt - 1), 5000);
    const seconds = Math.max(1, Math.round(delay / 1000));
    setCaptureStatus("capturing");
    setStatusMessage(`Connection lost. Reconnecting in ${seconds}s (attempt ${attempt})...`);
    setLiveAudioNotice(`Reconnecting in ${seconds}s...`);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (activeRef.current) {
        connectWebSocket(captureModeRef.current);
      }
    }, delay);
  };

  const connectWebSocket = (mode: CaptureMode) => {
    captureModeRef.current = mode;
    const effectiveTranslationProvider = sttProvider === "openai_realtime_translate" ? "openai" : translationProvider;
    const wsUrl = `${WS_API_BASE}/ws/audio?stt_provider=${sttProvider}&translation_provider=${effectiveTranslationProvider}&source_language=${sourceLanguage}&target_language=${targetLanguage}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttemptsRef.current = 0;
      setConnected(true);
      setBackendAvailable(true);
      setCaptureStatus("capturing");
      if (mode === "system") {
        setStatusMessage("Capturing local server system audio");
        setLiveAudioNotice("Listening for system audio...");
        ws.send(JSON.stringify({ type: "capture.system.start" }));
      } else if (mode === "microphone") {
        setStatusMessage("Recording microphone audio");
        setLiveAudioNotice("Listening to microphone...");
      } else {
        setStatusMessage("Recording selected tab/window audio");
        setLiveAudioNotice("Recording selected source audio...");
      }
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === "transcript.partial") {
        setLiveAudioNotice("");
        // Do not render unpaired source text in Live Output; it can lead the
        // translation by a few seconds and make Original/Translation mismatch.
      } else if (data.type === "transcript.final") {
        setLiveAudioNotice("");
        lastTranscriptFinalAtRef.current = Date.now();
      } else if (data.type === "language.detected") {
        // Backend auto-detected and pinned the source language; reflect it in the UI.
        setLanguages(data.source_language, useSubtitleStore.getState().targetLanguage);
        setStatusMessage(`Detected language: ${data.source_language}`);
      } else if (data.type === "translation.partial") {
        // Keep live Original/Translation semantically aligned: do not show
        // speculative translation partials from a different source segment.
        setLiveAudioNotice("");
      } else if (data.type === "translation.final") {
        setLiveAudioNotice("");
        setLivePartialTranslation("");
        const sourceText = data.source_text?.trim() || "Live translation";
        const translatedText = data.translated_text?.trim() || "";
        if (lastTranscriptFinalAtRef.current) {
          setTranslationLatencyMs(Date.now() - lastTranscriptFinalAtRef.current);
        }

        // Keep Original and Translation aligned to the same finalized source segment.
        if (sourceText !== "Live translation") {
          updatePartial("");
          commitFinalTranscript(sourceText);
        }

        if (translatedText) {
          setRecentTranslations([{ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, text: translatedText }]);
        }
        commitTranslation(sourceText, translatedText);
        pushOverlay({
          type: "translation",
          sourceText,
          translatedText,
        });
      } else if (data.type === "capture.status") {
        const message = data.message || "Working";
        setStatusMessage(message);
        setLiveAudioNotice(message);
      } else if (data.type === "translation.error") {
        // Transient translation failure (rate limit, blip). Session stays alive.
        setStatusMessage(`Translation retry: ${data.message || "temporary error"}`);
      } else if (data.type === "error") {
        const message = data.message || "Transcription error";
        setCaptureStatus("error");
        setStatusMessage(message);
        setLiveAudioNotice(message);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      if (activeRef.current) {
        // Unexpected drop while the user is still capturing -> auto-reconnect.
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      setBackendAvailable(false);
      // onclose fires right after and handles reconnect; only surface a hard
      // error when the user is not actively capturing.
      if (!activeRef.current) {
        setCaptureStatus("error");
        setStatusMessage("Backend connection failed");
        setLiveAudioNotice("Backend connection failed");
      }
    };
  };


  const sendPcmFrame = (base64Audio: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    ws.send(JSON.stringify({
      type: "audio.chunk",
      audio_base64: base64Audio,
      mime_type: `audio/pcm;rate=${pcmRate(sttProvider)}`,
    }));
  };

  const stopPcmStreaming = () => {
    audioProcessorRef.current?.disconnect();
    audioProcessorRef.current = null;
    audioSourceRef.current?.disconnect();
    audioSourceRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
  };

  const startPcmStreaming = (stream: MediaStream) => {
    stopPcmStreaming();

    const AudioContextConstructor = window.AudioContext || (window as any).webkitAudioContext;
    const audioContext = new AudioContextConstructor();
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(1024, 1, 1);
    const silenceRmsThreshold = 0.004;
    let speechHangoverFrames = 0;

    processor.onaudioprocess = (event) => {
      if (!activeRef.current) {
        return;
      }

      const input = event.inputBuffer.getChannelData(0);
      let sumSquares = 0;
      for (let i = 0; i < input.length; i += 1) {
        sumSquares += input[i] * input[i];
      }
      const rms = Math.sqrt(sumSquares / Math.max(1, input.length));
      if (rms >= silenceRmsThreshold) {
        speechHangoverFrames = 12;
      } else if (speechHangoverFrames <= 0) {
        return;
      } else {
        speechHangoverFrames -= 1;
      }

      const downsampled = downsampleBuffer(input, audioContext.sampleRate, pcmRate(sttProvider));
      sendPcmFrame(pcm16Base64(downsampled));
    };

    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);

    audioContextRef.current = audioContext;
    audioSourceRef.current = source;
    audioProcessorRef.current = processor;

    setStatusMessage(`Streaming PCM audio to ${sttProvider === "gemini_live" ? "Gemini Live" : sttProvider === "openai_realtime_translate" ? "OpenAI Realtime Translate" : "OpenAI Realtime"}`);
    setLiveAudioNotice("Streaming live audio...");
  };
  const sendBlob = async (blob: Blob) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || blob.size < 1024) {
      return;
    }

    setLiveAudioNotice(`Sending ${Math.max(1, Math.round(blob.size / 1024))} KB audio segment...`);
    const audioBase64 = await blobToBase64(blob);
    ws.send(JSON.stringify({
      type: "audio.chunk",
      audio_base64: audioBase64,
      mime_type: blob.type || "audio/webm",
    }));
  };

  const recordNextSegment = (stream: MediaStream) => {
    if (!activeRef.current) {
      return;
    }

    const audioTracks = stream.getAudioTracks().filter((track) => track.readyState === "live");
    if (audioTracks.length === 0) {
      setCaptureStatus("error");
      setStatusMessage("Selected source has no live audio track. Choose a browser tab and enable audio sharing.");
      stopCapture();
      return;
    }

    const audioStream = new MediaStream(audioTracks);
    const mimeType = getRecorderMimeType();
    const chunks: Blob[] = [];

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : undefined);
    } catch (error) {
      setCaptureStatus("error");
      setStatusMessage(error instanceof Error ? error.message : "MediaRecorder could not be created");
      stopCapture();
      return;
    }

    recorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    recorder.onerror = (event) => {
      setCaptureStatus("error");
      setStatusMessage(event.error?.message || "MediaRecorder failed while recording");
      stopCapture();
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      void sendBlob(blob).finally(() => {
        if (activeRef.current && stream.getAudioTracks().some((track) => track.readyState === "live")) {
          if (isPcmStreaming(sttProvider)) {
            startPcmStreaming(stream);
          } else {
            recordNextSegment(stream);
          }
        }
      });
    };

    try {
      recorder.start(SEGMENT_MS);
      setStatusMessage("Recording selected source audio segment");
      setLiveAudioNotice("Recording selected source audio...");
      segmentTimerRef.current = setTimeout(() => {
        if (recorder.state === "recording") {
          recorder.stop();
        }
      }, SEGMENT_MS + 250);
    } catch (error) {
      setCaptureStatus("error");
      setStatusMessage(error instanceof Error ? error.message : "MediaRecorder could not start");
      stopCapture();
    }
  };

  const startSystemCapture = () => {
    activeRef.current = true;
    setCapturing(true);
    setCaptureStatus("capturing");
    setStatusMessage("Connecting to backend system audio capture");
    startSession();
    connectWebSocket("system");
  };

  const startMicrophoneCapture = async () => {
    try {
      setCaptureMode("microphone");
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setCaptureStatus("error");
        setStatusMessage("Microphone capture requires HTTPS and browser permission.");
        setLiveAudioNotice("Browser blocked microphone capture on this origin.");
        return;
      }

      setCaptureStatus("selecting");
      setStatusMessage("Allow microphone access to start live translation");

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        } as MediaTrackConstraints,
        video: false,
      });

      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((track) => track.stop());
        setCaptureStatus("error");
        setStatusMessage("Microphone did not expose an audio track.");
        setLiveAudioNotice("No microphone audio track was shared.");
        return;
      }

      streamRef.current = stream;
      stream.getTracks().forEach((track) => {
        track.onended = () => {
          if (activeRef.current) {
            stopCapture();
          }
        };
      });

      activeRef.current = true;
      setCapturing(true);
      setCaptureStatus("capturing");
      startSession();
      connectWebSocket("microphone");
      if (isPcmStreaming(sttProvider)) {
        startPcmStreaming(stream);
      } else {
        recordNextSegment(stream);
      }
    } catch (error) {
      activeRef.current = false;
      setCapturing(false);
      setConnected(false);
      setCaptureStatus("error");
      setStatusMessage(error instanceof Error ? error.message : "Microphone capture failed");
    }
  };

  const startWindowCapture = async () => {
    try {
      setCaptureMode("window");
      if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) {
        setCaptureStatus("error");
        setStatusMessage("Tab/Window capture requires HTTPS or localhost. Open this app with https, localhost, or use the desktop app.");
        setLiveAudioNotice("Browser blocked screen audio capture on this origin.");
        return;
      }

      setCaptureStatus("selecting");
      setStatusMessage("Select a browser tab or player window and enable audio sharing");

      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          suppressLocalAudioPlayback: false,
        } as MediaTrackConstraints,
        video: {
          displaySurface: "browser",
        } as MediaTrackConstraints,
        systemAudio: "include",
        windowAudio: "system",
      } as DisplayMediaStreamOptions);

      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((track) => track.stop());
        setCaptureStatus("error");
        setStatusMessage("Selected tab/window did not expose audio. Choose a tab with audio sharing enabled, or use Microphone on mobile.");
        setLiveAudioNotice("No audio track was shared.");
        return;
      }

      streamRef.current = stream;
      stream.getTracks().forEach((track) => {
        track.onended = () => {
          if (activeRef.current) {
            stopCapture();
          }
        };
      });

      activeRef.current = true;
      setCapturing(true);
      setCaptureStatus("capturing");
      startSession();
      connectWebSocket("window");
      if (isPcmStreaming(sttProvider)) {
        startPcmStreaming(stream);
      } else {
        recordNextSegment(stream);
      }
    } catch (error) {
      activeRef.current = false;
      setCapturing(false);
      setConnected(false);
      setCaptureStatus("error");
      setStatusMessage(error instanceof Error ? error.message : "Capture failed");
    }
  };

  const startCapture = async () => {
    if (!captureMode) {
      setCaptureStatus("idle");
      setStatusMessage("Choose System Audio, Tab / Window, or Microphone first.");
      return;
    }
    if (captureMode === "system" && !systemCaptureAvailable) {
      setCaptureStatus("error");
      setStatusMessage("System Audio is not available on the hosted web app. Use Tab / Window or Microphone.");
      setLiveAudioNotice("Hosted web cannot capture your computer system audio.");
      return;
    }
    if (captureMode === "window" && !windowCaptureAvailable) {
      setCaptureStatus("error");
      setStatusMessage("Tab/Window capture requires HTTPS or localhost.");
      setLiveAudioNotice("Browser blocked tab/window capture on this origin.");
      return;
    }
    if (captureMode === "microphone" && !microphoneCaptureAvailable) {
      setCaptureStatus("error");
      setStatusMessage("Microphone capture requires HTTPS and browser permission.");
      setLiveAudioNotice("Browser blocked microphone capture on this origin.");
      return;
    }
    if (captureMode === "system") {
      startSystemCapture();
    } else if (captureMode === "microphone") {
      await startMicrophoneCapture();
    } else {
      await startWindowCapture();
    }
  };

  const stopCapture = () => {
    activeRef.current = false;
    setCapturing(false);
    setCaptureMode(null);
    setCaptureStatus("idle");
    setStatusMessage("Choose capture mode to start again.");
    setLiveAudioNotice("");
    setLivePartialTranslation("");
    setRecentTranslations([]);
    setTranslationLatencyMs(null);
    lastTranscriptFinalAtRef.current = null;

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptsRef.current = 0;

    if (segmentTimerRef.current) {
      clearTimeout(segmentTimerRef.current);
      segmentTimerRef.current = null;
    }

    stopPcmStreaming();

    if (recorderRef.current && recorderRef.current.state === "recording") {
      recorderRef.current.stop();
    }
    recorderRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    const ws = wsRef.current;
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "capture.system.stop" }));
      }
      ws.close();
      wsRef.current = null;
    }
    setConnected(false);
  };

  const handleSelectCaptureMode = async (mode: CaptureMode) => {
    if (isCapturing) {
      return;
    }
    if (mode === "system" && !systemCaptureAvailable) {
      setCaptureStatus("error");
      setLiveAudioNotice("System Audio is only available in the desktop app or on the same local machine as the API server.");
      setStatusMessage("Use Tab / Window or Microphone on the hosted web app.");
      setCaptureMode(null);
      return;
    }
    if (mode === "microphone" && !microphoneCaptureAvailable) {
      setCaptureStatus("error");
      setLiveAudioNotice("Microphone capture requires HTTPS and browser microphone permission.");
      setStatusMessage("Open the app over HTTPS and allow microphone access.");
      setCaptureMode(null);
      return;
    }
    if (mode === "window" && !windowCaptureAvailable) {
      setCaptureStatus("error");
      setLiveAudioNotice("Browser blocked tab/window capture on this HTTP origin.");
      setStatusMessage("Tab/Window capture requires HTTPS or localhost. Use https://rtvoice.com after TLS is ready, localhost, or the desktop app.");
      setCaptureMode(null);
      return;
    }
    setCaptureMode(mode);
    if (mode === "window") {
      await startWindowCapture();
      return;
    }
    if (mode === "microphone") {
      await startMicrophoneCapture();
      return;
    }
    setCaptureStatus("idle");
    setLiveAudioNotice("");
    setStatusMessage("System Audio mode selected. Press Capture System Audio to start.");
  };

  const handleToggleCapturing = () => {
    if (isCapturing) {
      stopCapture();
    } else {
      void startCapture();
    }
  };

  const handleToggleOverlay = () => {
    const hasElectron = typeof window !== "undefined" && (window as any).electronAPI;
    if (!hasElectron) {
      // The always-on-top overlay window only exists in the desktop (Electron) app.
      setStatusMessage("Overlay is only available in the desktop app (run: pnpm dev:desktop). It does nothing in a browser.");
      return;
    }
    const nextState = !overlayActive;
    setOverlayActive(nextState);
    (window as any).electronAPI.toggleOverlay(nextState);
  };

  return (
    <div className={isLightTheme ? "theme-light min-h-screen bg-slate-100 text-slate-950" : "min-h-screen bg-darkBg text-gray-100"}>
      <header className="flex flex-col gap-4 border-b border-white/5 bg-darkBg/90 px-5 py-4 backdrop-blur-xl sm:px-8 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-white text-darkBg shadow-lg shadow-black/30">
            <Captions className="h-5 w-5" />
          </div>
          <div>
            <h1 className="font-display text-xl font-semibold tracking-normal text-white">LiveSub AI</h1>
            <p className="text-xs text-gray-500">Cinema-grade live subtitles</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setIsLightTheme(!isLightTheme)}
            className="theme-toggle"
            aria-pressed={isLightTheme}
            title={isLightTheme ? "Switch to dark theme" : "Switch to light theme"}
          >
            {isLightTheme ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
            {isLightTheme ? "Dark" : "White"}
          </button>
          <div className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-[11px] font-semibold text-gray-400">{APP_BUILD_VERSION}</div>
          <div className="chip chip-success">
            <span className={`h-2 w-2 rounded-full ${isConnected || backendAvailable ? "bg-accentGreen" : "bg-red-500"}`} />
            <span className="text-gray-400">Server</span>
            <span className="font-semibold">{isConnected ? "Connected" : backendAvailable ? "Ready" : isCapturing ? "Connecting" : "Offline"}</span>
          </div>
          <div className="chip chip-purple">
            <Activity className="h-3.5 w-3.5 text-accentPurple" />
            <span className="font-semibold capitalize">{captureStatus}</span>
          </div>
          <div className="chip chip-warning">
            <span className="text-gray-400">Delay</span>
            <span className="font-semibold">{translationLatencyMs === null ? "--" : `${(translationLatencyMs / 1000).toFixed(1)}s`}</span>
          </div>
        </div>
      </header>

      <main className="grid min-h-[calc(100vh-74px)] grid-cols-1 gap-6 p-5 sm:p-7 xl:grid-cols-[260px_minmax(0,1fr)_220px] 2xl:grid-cols-[280px_minmax(0,1fr)_240px]">
        <section className="flex min-h-0 flex-col gap-5 xl:overflow-y-auto xl:pr-1">
          <div className="panel-shell flex flex-col gap-4 p-4">
            <h2 className="font-display flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">
              <Sliders className="h-4 w-4" /> ENGINE
            </h2>

            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-gray-400">STT Provider</label>
              <select
                disabled={isCapturing}
                value={sttProvider}
                onChange={(e) => setProviders(e.target.value, translationProvider)}
                className="control-select"
              >
                <option value="openai_realtime_translate">OpenAI Realtime Translate (stable)</option>
                <option value="openai_realtime">OpenAI Realtime Whisper</option>
                <option value="gemini_live">Gemini Live API</option>
              </select>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-gray-400">Translation Provider</label>
              <select
                disabled={isCapturing}
                value={translationProvider}
                onChange={(e) => setProviders(sttProvider, e.target.value)}
                className="control-select"
              >
                <option value="facebook_nllb">Facebook NLLB distilled 600M</option>
                <option value="openai">OpenAI API</option>
                <option value="gemini">Gemini API</option>
              </select>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-gray-400">Capture Mode</label>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  disabled={isCapturing || !systemCaptureAvailable}
                  title={!systemCaptureAvailable ? "Hosted web cannot capture your computer system audio. Use Tab / Window or Microphone." : undefined}
                  aria-pressed={captureMode === "system"}
                  onClick={() => void handleSelectCaptureMode("system")}
                  className={`capture-mode-button ${
                    captureMode === "system"
                      ? "border-white/20 bg-white/10 text-white"
                      : "border-white/[0.08] bg-white/[0.03] text-gray-400 hover:border-white/20 hover:text-gray-200"
                  }`}
                >
                  System Audio
                </button>
                <button
                  type="button"
                  disabled={isCapturing || !windowCaptureAvailable}
                  title={!windowCaptureAvailable ? "Tab / Window capture requires HTTPS or localhost." : undefined}
                  aria-pressed={captureMode === "window"}
                  onClick={() => void handleSelectCaptureMode("window")}
                  className={`capture-mode-button ${
                    captureMode === "window"
                      ? "border-white/20 bg-white/10 text-white"
                      : "border-white/[0.08] bg-white/[0.03] text-gray-400 hover:border-white/20 hover:text-gray-200"
                  }`}
                >
                  Tab / Window
                </button>
                <button
                  type="button"
                  disabled={isCapturing || !microphoneCaptureAvailable}
                  title={!microphoneCaptureAvailable ? "Microphone requires HTTPS and browser permission." : undefined}
                  aria-pressed={captureMode === "microphone"}
                  onClick={() => void handleSelectCaptureMode("microphone")}
                  className={`capture-mode-button ${
                    captureMode === "microphone"
                      ? "border-white/20 bg-white/10 text-white"
                      : "border-white/[0.08] bg-white/[0.03] text-gray-400 hover:border-white/20 hover:text-gray-200"
                  }`}
                >
                  Microphone
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-1 text-xs font-medium text-gray-400">
                  <Globe className="h-3 w-3 text-accentBlue" /> Source
                </label>
                <select
                  disabled={isCapturing}
                  value={sourceLanguage}
                  onChange={(e) => setLanguages(e.target.value, targetLanguage)}
                  className="control-select"
                >
                  <option value="auto">Auto Detect</option>
                  <option value="ko">Korean</option>
                  <option value="en">English</option>
                  <option value="ja">Japanese</option>
                </select>
              </div>

              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-1 text-xs font-medium text-gray-400">
                  <Languages className="h-3 w-3 text-accentPurple" /> Target
                </label>
                <select
                  disabled={isCapturing}
                  value={targetLanguage}
                  onChange={(e) => setLanguages(sourceLanguage, e.target.value)}
                  className="control-select"
                >
                  <option value="ko">Korean</option>
                  <option value="en">English</option>
                  <option value="ja">Japanese</option>
                </select>
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-darkBorder/50 pt-4">
              <label className="flex items-center gap-1.5 text-xs font-medium text-gray-400">
                <RotateCcw className="h-3 w-3 text-accentBlue" /> Reset log on new capture
              </label>
              <button
                type="button"
                role="switch"
                aria-checked={resetOnNewCapture}
                disabled={isCapturing}
                onClick={() => setResetOnNewCapture(!resetOnNewCapture)}
                className={`relative h-5 w-9 shrink-0 rounded-full transition disabled:opacity-50 ${resetOnNewCapture ? "bg-accentPurple" : "bg-white/[0.12]"}`}
              >
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${resetOnNewCapture ? "left-4" : "left-0.5"}`} />
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <button
              onClick={handleToggleCapturing}
              className={`flex w-full items-center justify-center gap-3 rounded-2xl px-5 py-4 text-sm font-semibold shadow-lg transition ${
                isCapturing
                  ? "bg-red-500/90 text-white hover:bg-red-500"
                  : "bg-white text-darkBg hover:bg-gray-200"
              }`}
            >
              {isCapturing ? <Square className="h-5 w-5 fill-current" /> : <Play className="h-5 w-5 fill-current" />}
              {isCapturing
                ? "Stop Captions"
                : captureMode === "system"
                  ? "Capture System Audio"
                  : captureMode === "window"
                    ? "Select Window/Tab Audio"
                    : captureMode === "microphone"
                      ? "Capture Microphone"
                      : "Select Capture Mode"}
            </button>

            <button
              onClick={handleToggleOverlay}
              className={`flex w-full items-center justify-center gap-2 rounded-2xl border px-5 py-3.5 text-sm font-medium transition ${
                overlayActive
                  ? "border-accentPurple/50 bg-accentPurple/15 text-purple-100"
                  : "border-white/10 bg-white/[0.04] text-gray-300 hover:bg-white/[0.08]"
              }`}
            >
              <Tv className="h-4 w-4" />
              {overlayActive ? "Hide Overlay" : "Show Overlay"}
            </button>
          </div>

          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-4 text-sm text-gray-300">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
              <MonitorUp className="h-3.5 w-3.5" /> Capture Status
            </div>
            <p className={captureStatus === "error" ? "text-red-300" : "text-gray-300"}>{statusMessage}</p>
          </div>
        </section>

        <section className="flex min-h-0 flex-col gap-6">
          <div className="cinema-stage relative flex min-h-[430px] flex-[1.15] flex-col overflow-hidden rounded-[28px] p-7 sm:p-9 xl:min-h-[520px]">
            <div className="mb-5 flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-gray-400">
                <Activity className="h-3.5 w-3.5" /> Live Output
              </div>
              {isCapturing ? (
                <span className="flex items-center gap-1.5 rounded-full bg-red-500/10 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-red-400">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" /> LIVE
                </span>
              ) : (
                <span className="flex items-center gap-1.5 rounded-full bg-darkCard px-2.5 py-1 text-[11px] font-semibold tracking-wide text-gray-500">
                  <span className="h-1.5 w-1.5 rounded-full bg-gray-600" /> IDLE
                </span>
              )}
            </div>

            <div className="z-10 grid flex-1 select-text grid-rows-[auto_minmax(0,1fr)] gap-5">
              <div className="flex flex-col justify-start rounded-3xl border border-white/[0.08] bg-black/20 px-5 py-4">
                <p className="font-display mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500">
                  <span className="h-1 w-1 rounded-full bg-accentBlue" /> Original
                </p>
                <p className="max-h-[8rem] min-h-[3.5rem] overflow-hidden whitespace-pre-wrap break-words font-sans text-lg font-medium leading-relaxed text-gray-400 md:text-xl">
                  {finalTranscript || partialTranscript ? (
                    <>
                      <span>{tailText(finalTranscript, 520)}</span>
                      {partialTranscript && <span className="ml-2 animate-pulse text-gray-300">{tailText(partialTranscript, 700)}...</span>}
                    </>
                  ) : (
                    <span className="italic text-gray-600">Source transcript appears here.</span>
                  )}
                </p>
              </div>

              <div className="subtitle-surface flex flex-col justify-end rounded-[28px] px-7 py-7 shadow-2xl">
                <p className="font-display mb-4 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-accentPurple">
                  <span className="h-1 w-1 rounded-full bg-accentPurple" /> Translation
                </p>
                <div className="font-display flex min-h-[8.5rem] flex-col justify-end gap-2 leading-tight">
                  {translationLines.length > 0 ? (
                    translationLines.map((line, i) => {
                      const isCurrent = i === translationLines.length - 1;
                      return (
                        <p
                          key={line.key}
                          className={
                            "animate-line-in break-keep whitespace-pre-wrap " +
                            (isCurrent
                              ? `subtitle-live text-3xl font-semibold md:text-5xl ${line.isPartial ? "text-purple-100/90" : "text-white"}`
                              : "text-xl font-medium text-gray-500/60 md:text-2xl")
                          }
                        >
                          {tailText(line.text, 220)}
                          {line.isPartial && <span className="ml-1 animate-pulse text-accentPurple">|</span>}
                        </p>
                      );
                    })
                  ) : liveAudioNotice ? (
                    <p className="text-xl font-medium text-gray-400 md:text-2xl">{liveAudioNotice}</p>
                  ) : isCapturing ? (
                    <p className="text-xl font-medium italic text-gray-600 md:text-2xl">Waiting for speech...</p>
                  ) : (
                    <p className="text-xl font-medium italic text-gray-600 md:text-2xl">No active capture.</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="panel-shell flex min-h-[360px] flex-[0.85] flex-col gap-4 p-5 xl:min-h-0">
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-3">
              <h3 className="font-display flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">
                <History className="h-4 w-4 text-accentBlue" /> CAPTION LOG
                {selectedSession && (
                  <span className="ml-1 truncate rounded-full bg-darkBorder/60 px-2 py-0.5 text-[10px] font-medium text-gray-400">
                    {selectedSession.label} - {sessionItems.length}
                  </span>
                )}
              </h3>
              <button
                onClick={clearHistory}
                disabled={sessions.length === 0}
                className="flex items-center gap-1 text-xs text-gray-500 transition hover:text-red-400 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" /> Clear all
              </button>
            </div>

            <div className="flex gap-1 rounded-2xl bg-black/20 p-1 text-xs">
              {([["both", "Both"], ["original", "Original"], ["translation", "Translation"]] as const).map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => setLogView(v)}
                  className={`flex-1 rounded-md px-3 py-1.5 font-medium transition ${
                    logView === v ? "bg-white/10 text-white" : "text-gray-500 hover:text-gray-300"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-2">
              {sessionItems.length > 0 ? (
                sessionItems.map((item) => (
                  <article
                    key={item.id}
                    className="script-card animate-fade-in mx-auto w-full max-w-4xl p-4"
                  >
                    <div className="mb-3 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-gray-600">
                      <FileText className="h-3 w-3" />
                      <time>{new Date(item.timestamp).toLocaleTimeString()}</time>
                    </div>
                    {logView !== "translation" && (
                      <p className="font-sans text-base leading-relaxed text-gray-400">{item.sourceText}</p>
                    )}
                    {logView !== "original" && (
                      <p className={`font-display text-xl font-semibold leading-relaxed text-white ${logView === "both" ? "mt-2" : ""}`}>
                        {item.translatedText}
                      </p>
                    )}
                  </article>
                ))
              ) : (
                <div className="flex flex-1 items-center justify-center py-8 text-xs text-gray-600">No captions yet.</div>
              )}
            </div>
          </div>
        </section>

        <section className="flex min-h-0 flex-col gap-5">
          <div className="panel-shell flex max-h-[420px] flex-col gap-3 p-4 xl:max-h-none">
            <div className="flex items-center gap-2 border-b border-white/[0.08] pb-3 font-display text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">
              <List className="h-4 w-4 text-accentPurple" /> SESSIONS
              {sessions.length > 0 && (
                <span className="rounded-full bg-darkBorder/60 px-2 py-0.5 text-[10px] font-medium text-gray-500">{sessions.length}</span>
              )}
              <button
                onClick={clearHistory}
                disabled={sessions.length === 0 || isCapturing}
                title="Clear all sessions"
                className="ml-auto flex items-center gap-1 text-xs font-normal text-gray-500 transition hover:text-red-400 disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" /> Clear
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
              {sessions.length > 0 ? (
                visibleSessions.map((s) => {
                  const isActive = s.id === activeSessionId && isCapturing;
                  const isSelected = s.id === (selectedSession?.id ?? null);
                  return (
                    <button
                      key={s.id}
                      onClick={() => selectSession(s.id)}
                      className={`flex flex-col gap-1 rounded-2xl border px-3 py-2.5 text-left transition ${
                        isSelected
                          ? "border-accentPurple/40 bg-accentPurple/10"
                          : "border-white/[0.08] bg-black/20 hover:border-white/[0.16]"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-display text-xs font-semibold text-gray-200">{s.label}</span>
                        {isActive && (
                          <span className="flex shrink-0 items-center gap-1 text-[9px] font-semibold text-red-400">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" /> LIVE
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] text-gray-500">{s.items.length} captions</span>
                      {s.items[0] && (
                        <span className="truncate text-[11px] text-purple-300/80">{s.items[0].translatedText}</span>
                      )}
                    </button>
                  );
                })
              ) : (
                <div className="flex flex-1 items-center justify-center px-2 py-8 text-center text-xs leading-relaxed text-gray-600">
                  Press play to start a capture session.
                </div>
              )}
              {hiddenSessionCount > 0 && (
                <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-center text-xs text-gray-500">
                  +{hiddenSessionCount} older sessions folded
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}















