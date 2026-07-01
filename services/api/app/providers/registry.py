from typing import Dict, Type
from app.providers.base import STTProvider, TranslationProvider
from app.providers.local_provider import LocalWhisperSTTProvider, LocalNLLBTranslationProvider
from app.providers.mock import MockSTTProvider, MockTranslationProvider
from app.providers.openai_provider import OpenAIChunkedSTTProvider, OpenAITranslationProvider
from app.providers.openai_realtime_provider import OpenAIRealtimeSTTProvider, OpenAIRealtimeTranslateProvider
from app.providers.gemini_provider import GeminiTranslationProvider, GeminiSTTProvider, GeminiLiveSTTProvider

class ProviderRegistry:
    def __init__(self):
        self._stt_providers: Dict[str, Type[STTProvider]] = {
            "mock": MockSTTProvider,
            "openai": OpenAIChunkedSTTProvider,
            "openai_realtime": OpenAIRealtimeSTTProvider,
            "openai_realtime_whisper": OpenAIRealtimeSTTProvider,
            "openai_realtime_translate": OpenAIRealtimeSTTProvider,
            "gpt_realtime_translate": OpenAIRealtimeSTTProvider,
            "openai_realtime_translate_direct": OpenAIRealtimeTranslateProvider,
            "local_whisper": LocalWhisperSTTProvider,
            "whisper_local": LocalWhisperSTTProvider,
            "faster_whisper": LocalWhisperSTTProvider,
            "gemini": GeminiSTTProvider,
            "google_gemini": GeminiSTTProvider,
            "gemini_live": GeminiLiveSTTProvider,
            "gemini_live_api": GeminiLiveSTTProvider,
        }
        self._translation_providers: Dict[str, Type[TranslationProvider]] = {
            "mock": MockTranslationProvider,
            "openai": OpenAITranslationProvider,
            "gemini": GeminiTranslationProvider,
            "google_gemini": GeminiTranslationProvider,
            "local_nllb": LocalNLLBTranslationProvider,
            "facebook_nllb": LocalNLLBTranslationProvider,
            "nllb": LocalNLLBTranslationProvider,
        }

    def get_stt(self, name: str) -> STTProvider:
        provider_cls = self._stt_providers.get(name.lower(), LocalWhisperSTTProvider)
        return provider_cls()

    def get_translation(self, name: str) -> TranslationProvider:
        provider_cls = self._translation_providers.get(name.lower(), LocalNLLBTranslationProvider)
        return provider_cls()

registry = ProviderRegistry()