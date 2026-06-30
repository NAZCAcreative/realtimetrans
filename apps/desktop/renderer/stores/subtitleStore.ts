import { create } from "zustand";

export interface SubtitleItem {
  id: string;
  sourceText: string;
  translatedText: string;
  timestamp: number;
}

interface SubtitleState {
  isCapturing: boolean;
  isConnected: boolean;
  sttProvider: string;
  translationProvider: string;
  sourceLanguage: string;
  targetLanguage: string;
  
  // Real-time subtitle values
  partialTranscript: string;
  finalTranscript: string;
  translatedText: string;
  
  history: SubtitleItem[];
  
  // Setters/actions
  setCapturing: (val: boolean) => void;
  setConnected: (val: boolean) => void;
  setProviders: (stt: string, trans: string) => void;
  setLanguages: (src: string, target: string) => void;
  
  updatePartial: (text: string) => void;
  commitFinalTranscript: (text: string) => void;
  commitTranslation: (sourceText: string, translatedText: string) => void;
  clearHistory: () => void;
}

export const useSubtitleStore = create<SubtitleState>((set) => ({
  isCapturing: false,
  isConnected: false,
  sttProvider: "local_whisper",
  translationProvider: "facebook_nllb",
  sourceLanguage: "en",
  targetLanguage: "ko",
  
  partialTranscript: "",
  finalTranscript: "",
  translatedText: "",
  history: [],

  setCapturing: (val) => set({ isCapturing: val }),
  setConnected: (val) => set({ isConnected: val }),
  setProviders: (stt, trans) => set({ sttProvider: stt, translationProvider: trans }),
  setLanguages: (src, target) => set({ sourceLanguage: src, targetLanguage: target }),

  updatePartial: (text) => set({ partialTranscript: text }),
  
  commitFinalTranscript: (text) => set({
    finalTranscript: text,
    partialTranscript: "", // clear partial
  }),
  
  commitTranslation: (sourceText, translatedText) => set((state) => {
    const newItem: SubtitleItem = {
      id: Math.random().toString(36).substr(2, 9),
      sourceText,
      translatedText,
      timestamp: Date.now()
    };
    return {
      translatedText,
      history: [newItem, ...state.history].slice(0, 100) // Keep last 100 items
    };
  }),

  clearHistory: () => set({ history: [], finalTranscript: "", translatedText: "", partialTranscript: "" })
}));



