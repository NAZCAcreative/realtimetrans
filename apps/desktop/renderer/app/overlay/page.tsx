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
          setIsPartial(false);
        }
      });

      return () => {
        if (unsubscribe) unsubscribe();
      };
    }
  }, []);

  return (
    <div className="w-full h-full flex items-center justify-center select-none overflow-hidden p-2">
      {/* Semi-transparent dark background for subtitle readability on any screen background */}
      <div className="bg-black/75 border border-white/10 rounded-2xl px-6 py-3 max-w-[90%] text-center shadow-2xl backdrop-blur-md">
        {sourceText && (
          <p className="text-xs font-semibold text-accentBlue mb-1 font-sans opacity-90 select-none">
            {sourceText}{isPartial && "..."}
          </p>
        )}
        <p className="text-lg md:text-xl font-bold font-display text-white tracking-wide select-none leading-normal">
          {translatedText || "LiveSub AI Overlay Subtitles"}
        </p>
      </div>
    </div>
  );
}
