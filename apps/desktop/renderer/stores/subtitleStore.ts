import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface SubtitleItem {
  id: string;
  sourceText: string;
  translatedText: string;
  timestamp: number;
}

export interface CaptureSession {
  id: string;
  label: string;
  startedAt: number;
  items: SubtitleItem[];
}

interface SubtitleState {
  isCapturing: boolean;
  isConnected: boolean;
  sttProvider: string;
  translationProvider: string;
  sourceLanguage: string;
  targetLanguage: string;

  // Whether starting a new capture wipes previous session logs.
  resetOnNewCapture: boolean;

  // Real-time subtitle values
  partialTranscript: string;
  finalTranscript: string;
  translatedText: string;

  // Per-play logs. Each capture start opens a new session.
  sessions: CaptureSession[];
  activeSessionId: string | null;   // session currently receiving captions
  selectedSessionId: string | null; // session shown in the log panel

  // Setters/actions
  setCapturing: (val: boolean) => void;
  setConnected: (val: boolean) => void;
  setProviders: (stt: string, trans: string) => void;
  setLanguages: (src: string, target: string) => void;
  setResetOnNewCapture: (val: boolean) => void;

  startSession: () => void;
  selectSession: (id: string) => void;

  updatePartial: (text: string) => void;
  commitFinalTranscript: (text: string) => void;
  clearLiveTranscript: () => void;
  commitTranslation: (sourceText: string, translatedText: string) => void;
  clearHistory: () => void;
}

const MAX_SESSIONS = 10;
// A speaking pause longer than this starts a new paragraph in the caption log.
const PARAGRAPH_GAP_MS = 3000;

const genId = () => Math.random().toString(36).substr(2, 9);

const sessionLabel = (index: number, startedAt: number) => {
  const t = new Date(startedAt).toLocaleTimeString();
  return `Session ${index} - ${t}`;
};

export const useSubtitleStore = create<SubtitleState>()(
  persist(
    (set) => ({
  isCapturing: false,
  isConnected: false,
  sttProvider: "openai_realtime_translate",
  translationProvider: "openai",
  sourceLanguage: "ko",
  targetLanguage: "ko",

  resetOnNewCapture: false,

  partialTranscript: "",
  finalTranscript: "",
  translatedText: "",

  sessions: [],
  activeSessionId: null,
  selectedSessionId: null,

  setCapturing: (val) => set({ isCapturing: val }),
  setConnected: (val) => set({ isConnected: val }),
  setProviders: (stt, trans) => set({ sttProvider: stt, translationProvider: trans }),
  setLanguages: (src, target) => set({ sourceLanguage: src, targetLanguage: target }),
  setResetOnNewCapture: (val) => set({ resetOnNewCapture: val }),

  startSession: () => set((state) => {
    const startedAt = Date.now();
    const priorSessions = state.resetOnNewCapture ? [] : state.sessions;
    const session: CaptureSession = {
      id: genId(),
      label: sessionLabel(priorSessions.length + 1, startedAt),
      startedAt,
      items: [],
    };
    return {
      sessions: [session, ...priorSessions].slice(0, MAX_SESSIONS),
      activeSessionId: session.id,
      selectedSessionId: session.id,
      partialTranscript: "",
      finalTranscript: "",
      translatedText: "",
    };
  }),

  selectSession: (id) => set({ selectedSessionId: id }),

  updatePartial: (text) => set({ partialTranscript: text }),

  commitFinalTranscript: (text) => set({
    finalTranscript: text,
    partialTranscript: "",
  }),

  clearLiveTranscript: () => set({
    finalTranscript: "",
    partialTranscript: "",
  }),

  commitTranslation: (sourceText, translatedText) => set((state) => {
    const now = Date.now();

    // Ensure there is an active session even if capture started before one opened.
    let sessions = state.sessions;
    let activeSessionId = state.activeSessionId;
    if (!activeSessionId || !sessions.some((s) => s.id === activeSessionId)) {
      const fresh: CaptureSession = {
        id: genId(),
        label: sessionLabel(sessions.length + 1, now),
        startedAt: now,
        items: [],
      };
      sessions = [fresh, ...sessions].slice(0, MAX_SESSIONS);
      activeSessionId = fresh.id;
    }

    // Group the log into ~3-second units broken at sentence boundaries: keep merging
    // finalized sentences into the current paragraph until PARAGRAPH_GAP_MS has passed
    // since it STARTED, then begin a new one. (timestamp holds the paragraph start.)
    sessions = sessions.map((s) => {
      if (s.id !== activeSessionId) return s;
      const last = s.items[0]; // newest-first
      if (last && now - last.timestamp < PARAGRAPH_GAP_MS) {
        const merged: SubtitleItem = {
          ...last,
          sourceText: `${last.sourceText} ${sourceText}`.trim(),
          translatedText: `${last.translatedText} ${translatedText}`.trim(),
          // keep last.timestamp: the 3s window is measured from the paragraph start,
          // not reset on each merge (otherwise continuous speech never breaks).
        };
        return { ...s, items: [merged, ...s.items.slice(1)] };
      }
      const newItem: SubtitleItem = { id: genId(), sourceText, translatedText, timestamp: now };
      return { ...s, items: [newItem, ...s.items].slice(0, 2000) };
    });

    return {
      translatedText,
      sessions,
      activeSessionId,
      selectedSessionId: state.selectedSessionId ?? activeSessionId,
    };
  }),

  clearHistory: () => set({
    sessions: [],
    activeSessionId: null,
    selectedSessionId: null,
    finalTranscript: "",
    translatedText: "",
    partialTranscript: "",
  }),
    }),
    {
      name: "livesub-store",
      // Persist logs + settings only; live/transient capture state stays in memory.
      partialize: (state) => ({
        sessions: state.sessions,
        selectedSessionId: state.selectedSessionId,
        sttProvider: state.sttProvider,
        translationProvider: state.translationProvider,
        sourceLanguage: state.sourceLanguage,
        targetLanguage: state.targetLanguage,
        resetOnNewCapture: state.resetOnNewCapture,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<SubtitleState> | undefined;
        return {
          ...current,
          sessions: saved?.sessions ?? current.sessions,
          selectedSessionId: saved?.selectedSessionId ?? current.selectedSessionId,
          sttProvider: saved?.sttProvider ?? current.sttProvider,
          translationProvider: saved?.translationProvider ?? current.translationProvider,
          sourceLanguage: !saved?.sourceLanguage || saved.sourceLanguage === "auto" ? "ko" : saved.sourceLanguage,
          targetLanguage: saved?.targetLanguage ?? current.targetLanguage,
          resetOnNewCapture: saved?.resetOnNewCapture ?? current.resetOnNewCapture,
        };
      },
    }
  )
);



