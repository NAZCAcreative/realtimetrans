from abc import ABC, abstractmethod
from typing import AsyncIterator, Generator, AsyncGenerator

# Human-readable language names for prompt-based providers (OpenAI, Gemini).
# LLMs translate far more reliably with full names than with ISO codes.
LANGUAGE_NAMES = {
    "auto": "the source language",
    "en": "English",
    "ko": "Korean",
    "ja": "Japanese",
    "zh": "Chinese",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
}


def resolve_language_name(code: str) -> str:
    """Map an ISO-ish language code to a human-readable name for prompts.

    Falls back to the raw code so unknown languages still pass through.
    """
    if not code:
        return "the source language"
    return LANGUAGE_NAMES.get(code.strip().lower(), code)

class STTProvider(ABC):
    @abstractmethod
    async def stream_transcribe(
        self, 
        audio_stream: AsyncGenerator[bytes, None]
    ) -> AsyncGenerator[dict, None]:
        """
        Streams audio bytes and yields transcript events.
        Events should be dicts like:
        - {"type": "partial", "text": "...", "stability": 0.0-1.0}
        - {"type": "final", "text": "...", "start_ms": int, "end_ms": int}
        """
        pass

class TranslationProvider(ABC):
    @abstractmethod
    async def translate(
        self,
        text: str,
        source_lang: str,
        target_lang: str,
        context: list[str] | None = None,
        glossary: dict[str, str] | None = None
    ) -> str:
        """
        Translates text from source_lang to target_lang.
        """
        pass
