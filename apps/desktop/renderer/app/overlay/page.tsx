"use client";

import React, { useEffect, useState } from "react";

export default function OverlayPage() {
  const [sourceText, setSourceText] = useState("");
  const [translatedText, setTranslatedText] = useState("");
  const [isPartial, setIsPartial] = useState(false);

  useEffect(() => {
    // Listen for broadcasted subtitle updates from the main process
    if (typeof window !== "undefined" && (window as any).electronAPI) {
      const unsubscribe = (window as any).electronAPI.onSubtitlesData((data: any) => {
        if (data.type === "partial") {
          setSourceText(data.text);
          setIsPartial(true);
        } else if (data.type === "final") {
          setSourceText(data.text);
          setIsPartial(false);
        } else if (data.type === "translation") {
          setSourceText(data.sourceText);
          setTranslatedText(data.translatedText);
          setIsPartial(Boolean(data.partial));
        }
      });

      return () => {
        if (unsubscribe) unsubscribe();
      };
    }
  }, []);

  return (
    <div className="w-full h-full flex items-end justify-center select-none overflow-hidden p-6">
      <div className="max-w-[92%] rounded-xl border border-white/15 bg-black/85 px-8 py-5 text-center shadow-2xl backdrop-blur-md">
        {sourceText && (
          <p className="mb-3 max-w-[72rem] truncate font-sans text-lg font-bold text-sky-100/90 select-none md:text-2xl">
            {sourceText}{isPartial && "..."}
          </p>
        )}
        <p className="max-w-[72rem] whitespace-pre-wrap break-keep font-display text-2xl font-extrabold leading-tight text-white select-none drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)] md:text-4xl">
          {translatedText || "LiveSub AI Overlay Subtitles"}
        </p>
      </div>
    </div>
  );
}



