from abc import ABC, abstractmethod
from typing import AsyncIterator, Generator, AsyncGenerator

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
