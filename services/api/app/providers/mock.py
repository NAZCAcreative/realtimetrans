import asyncio
from typing import AsyncGenerator
from app.providers.base import STTProvider, TranslationProvider

class MockSTTProvider(STTProvider):
    def __init__(self):
        self.sentences = [
            "Welcome to the LiveSub AI real-time translation platform.",
            "This project is a Windows desktop application built with Electron, Next.js, and FastAPI.",
            "Our system delivers ultra-low latency transcriptions and highly accurate translations.",
            "Let's check if the translation appears correctly in Korean.",
            "Feel free to toggle the overlay subtitle mode to see it float on your screen."
        ]
        self.sentence_index = 0

    async def stream_transcribe(
        self,
        audio_stream: AsyncGenerator[bytes, None]
    ) -> AsyncGenerator[dict, None]:
        """
        Simulates continuous transcription. As audio chunks are received, it yields
        partial transcripts and final transcripts for each demo sentence.
        """
        stream = audio_stream.__aiter__()

        while True:
            sentence = self.sentences[self.sentence_index]
            self.sentence_index = (self.sentence_index + 1) % len(self.sentences)
            words = sentence.split(" ")

            for word_idx in range(len(words)):
                try:
                    await stream.__anext__()
                except StopAsyncIteration:
                    return

                if word_idx < len(words) - 1:
                    yield {
                        "type": "partial",
                        "text": " ".join(words[:word_idx + 1]),
                        "stability": round(0.5 + (word_idx / len(words)) * 0.4, 2)
                    }
                    await asyncio.sleep(0.1)

            yield {
                "type": "final",
                "text": sentence,
                "start_ms": 1000 * self.sentence_index,
                "end_ms": 1000 * self.sentence_index + 3000
            }
            await asyncio.sleep(0.2)

class MockTranslationProvider(TranslationProvider):
    def __init__(self):
        self.translations = {
            "Welcome to the LiveSub AI real-time translation platform.":
                "LiveSub AI 실시간 번역 플랫폼에 오신 것을 환영합니다.",
            "This project is a Windows desktop application built with Electron, Next.js, and FastAPI.":
                "이 프로젝트는 Electron, Next.js, FastAPI로 만든 Windows 데스크톱 애플리케이션입니다.",
            "Our system delivers ultra-low latency transcriptions and highly accurate translations.":
                "이 시스템은 매우 낮은 지연 시간의 음성 인식과 정확한 번역을 제공합니다.",
            "Let's check if the translation appears correctly in Korean.":
                "한국어 번역이 제대로 표시되는지 확인해 보겠습니다.",
            "Feel free to toggle the overlay subtitle mode to see it float on your screen.":
                "오버레이 자막 모드를 켜면 화면 위에 떠 있는 자막을 볼 수 있습니다."
        }

    async def translate(
        self,
        text: str,
        source_lang: str,
        target_lang: str,
        context: list[str] | None = None,
        glossary: dict[str, str] | None = None
    ) -> str:
        """
        Translates text using the pre-defined dictionary, falling back to a dummy translation if not found.
        """
        await asyncio.sleep(0.3)

        translation = self.translations.get(text)
        if translation:
            return translation

        return f"[번역: {text}]"
