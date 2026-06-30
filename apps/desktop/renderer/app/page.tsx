"use client";

import React, { useRef, useState } from "react";
import { useSubtitleStore } from "../stores/subtitleStore";
import {
  Activity,
  Captions,
  FileText,
  Globe,
  History,
  Languages,
  MonitorUp,
  Play,
  Sliders,
  Square,
  Trash2,
  Tv,
} from "lucide-react";

const API_PORT = 8012;
const SEGMENT_MS = 3500;


type CaptureStatus = "idle" | "selecting" | "capturing" | "error";
type CaptureMode = "system" | "window";

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
    history,
    setCapturing,
    setConnected,
    setProviders,
    setLanguages,
    updatePartial,
    commitFinalTranscript,
    commitTranslation,
    clearHistory,
  } = useSubtitleStore();

  const [overlayActive, setOverlayActive] = useState(false);
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("Ready");
  const [captureMode, setCaptureMode] = useState<CaptureMode>("window");

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const segmentTimerRef = useRef<NodeJS.Timeout | null>(null);
  const activeRef = useRef(false);

  const pushOverlay = (data: any) => {
    if (typeof window !== "undefined" && (window as any).electronAPI) {
      (window as any).electronAPI.updateSubtitles(data);
    }
  };

  const connectWebSocket = (mode: CaptureMode) => {
    const wsUrl = `ws://127.0.0.1:${API_PORT}/ws/audio?stt_provider=${sttProvider}&translation_provider=${translationProvider}&source_language=${sourceLanguage}&target_language=${targetLanguage}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      if (mode === "system") {
        setStatusMessage("Capturing Windows system audio");
        ws.send(JSON.stringify({ type: "capture.system.start" }));
      } else {
        setStatusMessage("Recording selected tab/window audio");
      }
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === "transcript.partial") {
        updatePartial(data.text);
        pushOverlay({ type: "partial", text: data.text });
      } else if (data.type === "transcript.final") {
        commitFinalTranscript(data.text);
        pushOverlay({ type: "final", text: data.text });
      } else if (data.type === "translation.final") {
        commitTranslation(data.source_text, data.translated_text);
        pushOverlay({
          type: "translation",
          sourceText: data.source_text,
          translatedText: data.translated_text,
        });
      } else if (data.type === "capture.status") {
        setStatusMessage(data.message || "Working");
      } else if (data.type === "error") {
        setCaptureStatus("error");
        setStatusMessage(data.message || "Transcription error");
      }
    };

    ws.onclose = () => {
      setConnected(false);
      if (activeRef.current) {
        setCaptureStatus("error");
        setStatusMessage("Backend connection closed");
      }
    };

    ws.onerror = () => {
      setCaptureStatus("error");
      setStatusMessage("Backend connection failed");
    };
  };

  const sendBlob = async (blob: Blob) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || blob.size < 1024) {
      return;
    }

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
          recordNextSegment(stream);
        }
      });
    };

    try {
      recorder.start(SEGMENT_MS);
      setStatusMessage("Recording selected source audio segment");
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
    connectWebSocket("system");
  };

  const startWindowCapture = async () => {
    try {
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
        setStatusMessage("Selected tab/window did not expose audio. Falling back to Windows system audio.");
        startSystemCapture();
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
      connectWebSocket("window");
      recordNextSegment(stream);
    } catch (error) {
      activeRef.current = false;
      setCapturing(false);
      setConnected(false);
      setCaptureStatus("error");
      setStatusMessage(error instanceof Error ? error.message : "Capture failed");
    }
  };

  const startCapture = async () => {
    if (captureMode === "system") {
      startSystemCapture();
    } else {
      await startWindowCapture();
    }
  };

  const stopCapture = () => {
    activeRef.current = false;
    setCapturing(false);
    setCaptureStatus("idle");
    setStatusMessage("Stopped");

    if (segmentTimerRef.current) {
      clearTimeout(segmentTimerRef.current);
      segmentTimerRef.current = null;
    }

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

  const handleToggleCapturing = () => {
    if (isCapturing) {
      stopCapture();
    } else {
      void startCapture();
    }
  };

  const handleToggleOverlay = () => {
    const nextState = !overlayActive;
    setOverlayActive(nextState);
    if (typeof window !== "undefined" && (window as any).electronAPI) {
      (window as any).electronAPI.toggleOverlay(nextState);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-darkBg text-gray-100">
      <header className="glass flex items-center justify-between border-b border-darkBorder px-8 py-5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accentBlue shadow-lg shadow-accentBlue/20">
            <Captions className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="font-display text-xl font-bold tracking-wide text-white">LiveSub AI</h1>
            <p className="text-xs text-gray-500">System audio caption overlay</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-full border border-darkBorder bg-darkCard px-3 py-1.5 text-xs">
            <span className={`h-2 w-2 rounded-full ${isConnected ? "bg-accentGreen" : "bg-red-500"}`} />
            <span className="text-gray-400">Server</span>
            <span className="font-semibold">{isConnected ? "Connected" : isCapturing ? "Connecting" : "Idle"}</span>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-darkBorder bg-darkCard px-3 py-1.5 text-xs">
            <Activity className="h-3.5 w-3.5 text-accentPurple" />
            <span className="font-semibold capitalize">{captureStatus}</span>
          </div>
        </div>
      </header>

      <main className="grid flex-1 grid-cols-1 gap-6 p-8 lg:grid-cols-4">
        <section className="flex flex-col gap-6 lg:col-span-1">
          <div className="glass-interactive flex flex-col gap-6 rounded-lg bg-darkCard/30 p-6">
            <h2 className="font-display flex items-center gap-2 text-sm font-semibold tracking-wider text-accentPurple">
              <Sliders className="h-4 w-4" /> ENGINE
            </h2>

            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-gray-400">STT Provider</label>
              <select
                disabled={isCapturing}
                value={sttProvider}
                onChange={(e) => setProviders(e.target.value, translationProvider)}
                className="w-full rounded-lg border border-darkBorder bg-darkBg px-3 py-2 text-sm text-gray-200 outline-none transition focus:border-accentPurple disabled:opacity-50"
              >
                <option value="local_whisper">Local Whisper large-v3-turbo</option>
                <option value="openai">OpenAI API</option>
                <option value="mock">Mock demo</option>
              </select>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-gray-400">Translation Provider</label>
              <select
                disabled={isCapturing}
                value={translationProvider}
                onChange={(e) => setProviders(sttProvider, e.target.value)}
                className="w-full rounded-lg border border-darkBorder bg-darkBg px-3 py-2 text-sm text-gray-200 outline-none transition focus:border-accentPurple disabled:opacity-50"
              >
                <option value="facebook_nllb">Facebook NLLB distilled 600M</option>
                <option value="openai">OpenAI API</option>
                <option value="mock">Mock Korean</option>
              </select>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-gray-400">Capture Mode</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  disabled={isCapturing}
                  onClick={() => setCaptureMode("system")}
                  className={`rounded-lg border px-3 py-2 text-xs font-medium transition disabled:opacity-50 ${
                    captureMode === "system"
                      ? "border-accentBlue bg-accentBlue/20 text-blue-300"
                      : "border-darkBorder bg-darkBg text-gray-400 hover:border-gray-500"
                  }`}
                >
                  System Audio
                </button>
                <button
                  disabled={isCapturing}
                  onClick={() => setCaptureMode("window")}
                  className={`rounded-lg border px-3 py-2 text-xs font-medium transition disabled:opacity-50 ${
                    captureMode === "window"
                      ? "border-accentBlue bg-accentBlue/20 text-blue-300"
                      : "border-darkBorder bg-darkBg text-gray-400 hover:border-gray-500"
                  }`}
                >
                  Tab / Window
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
                  className="w-full rounded-lg border border-darkBorder bg-darkBg px-3 py-2 text-sm text-gray-200 outline-none focus:border-accentBlue disabled:opacity-50"
                >
                  <option value="en">English</option>
                  <option value="ko">Korean</option>
                  <option value="ja">Japanese</option>
                  <option value="auto">Auto</option>
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
                  className="w-full rounded-lg border border-darkBorder bg-darkBg px-3 py-2 text-sm text-gray-200 outline-none focus:border-accentPurple disabled:opacity-50"
                >
                  <option value="ko">Korean</option>
                  <option value="en">English</option>
                  <option value="ja">Japanese</option>
                </select>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <button
              onClick={handleToggleCapturing}
              className={`flex w-full items-center justify-center gap-3 rounded-lg px-6 py-4 font-semibold shadow-lg transition ${
                isCapturing
                  ? "bg-red-600 text-white hover:bg-red-500"
                  : "bg-accentBlue text-white hover:bg-blue-500"
              }`}
            >
              {isCapturing ? <Square className="h-5 w-5 fill-current" /> : <Play className="h-5 w-5 fill-current" />}
              {isCapturing ? "Stop Captions" : captureMode === "system" ? "Capture System Audio" : "Select Window/Tab Audio"}
            </button>

            <button
              onClick={handleToggleOverlay}
              className={`flex w-full items-center justify-center gap-2 rounded-lg border px-6 py-3.5 font-medium transition ${
                overlayActive
                  ? "border-accentPurple bg-accentPurple/20 text-purple-200"
                  : "border-darkBorder bg-darkCard/50 text-gray-300 hover:bg-darkCard/80"
              }`}
            >
              <Tv className="h-4 w-4" />
              {overlayActive ? "Hide Overlay" : "Show Overlay"}
            </button>
          </div>

          <div className="rounded-lg border border-darkBorder bg-darkCard/30 p-4 text-sm text-gray-300">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
              <MonitorUp className="h-3.5 w-3.5" /> Capture Status
            </div>
            <p className={captureStatus === "error" ? "text-red-300" : "text-gray-300"}>{statusMessage}</p>
          </div>
        </section>

        <section className="flex flex-col gap-6 lg:col-span-3">
          <div className="glass relative flex min-h-[360px] flex-1 flex-col justify-end overflow-hidden rounded-lg border border-darkBorder bg-darkCard/25 p-8">
            <div className="absolute left-6 top-6 flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-accentPurple">
              <Activity className="h-3.5 w-3.5" /> Live Output
            </div>

            <div className="z-10 flex max-w-full select-text flex-col gap-6">
              <div className="min-h-[76px]">
                <p className="font-display mb-1 text-xs font-semibold uppercase tracking-wider text-accentBlue">Original</p>
                <p className="font-sans text-xl font-medium leading-relaxed text-gray-100 md:text-2xl">
                  {finalTranscript || partialTranscript ? (
                    <>
                      <span>{finalTranscript}</span>
                      {partialTranscript && <span className="ml-2 animate-pulse text-gray-500">{partialTranscript}...</span>}
                    </>
                  ) : isCapturing ? (
                    <span className="text-lg italic text-gray-600">Waiting for speech...</span>
                  ) : (
                    <span className="text-lg italic text-gray-600">No active capture.</span>
                  )}
                </p>
              </div>

              <div className="min-h-[96px] border-t border-darkBorder/60 pt-5">
                <p className="font-display mb-1 text-xs font-semibold uppercase tracking-wider text-accentPurple">Translation</p>
                <p className="font-display text-2xl font-bold leading-normal text-white md:text-3xl">
                  {translatedText || <span className="text-xl font-normal italic text-gray-600">Translation will appear here.</span>}
                </p>
              </div>
            </div>
          </div>

          <div className="glass flex max-h-[300px] flex-col gap-4 rounded-lg border border-darkBorder bg-darkCard/20 p-6">
            <div className="flex items-center justify-between">
              <h3 className="font-display flex items-center gap-2 text-sm font-semibold tracking-wider text-gray-400">
                <History className="h-4 w-4 text-accentBlue" /> CAPTION HISTORY
              </h3>
              <button
                onClick={clearHistory}
                disabled={history.length === 0}
                className="flex items-center gap-1 text-xs text-gray-500 transition hover:text-red-400 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" /> Clear
              </button>
            </div>

            <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto pr-2">
              {history.length > 0 ? (
                history.map((item) => (
                  <div key={item.id} className="animate-fade-in flex flex-col gap-1.5 rounded-lg border border-darkBorder/40 bg-darkCard/60 p-3.5 transition hover:border-darkBorder">
                    <div className="flex items-center justify-between text-[10px] text-gray-500">
                      <span className="flex items-center gap-1"><FileText className="h-3 w-3" /> Segment</span>
                      <span>{new Date(item.timestamp).toLocaleTimeString()}</span>
                    </div>
                    <p className="font-sans text-sm text-gray-400">{item.sourceText}</p>
                    <p className="font-display text-sm font-semibold text-purple-300">{item.translatedText}</p>
                  </div>
                ))
              ) : (
                <div className="flex flex-1 items-center justify-center py-8 text-xs text-gray-600">No captions yet.</div>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}












