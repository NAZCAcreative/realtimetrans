import asyncio
from typing import AsyncGenerator
from app.providers.base import STTProvider, TranslationProvider

class RealtimeTranslationPipeline:
    def __init__(
        self,
        stt_provider: STTProvider,
        translation_provider: TranslationProvider
    ):
        self.stt_provider = stt_provider
        self.translation_provider = translation_provider

    async def run(self, send_json_callback, session_config: dict):
        audio_queue = asyncio.Queue()
        session_id = session_config.get("session_id", "default-session")
        source_lang = session_config.get("source_language", "en")
        target_lang = session_config.get("target_language", "ko")

        async def audio_stream_generator() -> AsyncGenerator[bytes, None]:
            while True:
                chunk = await audio_queue.get()
                if chunk is None:
                    break
                yield chunk

        async def pipeline_runner():
            try:
                async for event in self.stt_provider.stream_transcribe(audio_stream_generator()):
                    if event["type"] == "status":
                        await send_json_callback({
                            "type": "capture.status",
                            "session_id": session_id,
                            "message": event.get("message", "Working"),
                        })
                    elif event["type"] == "partial":
                        await send_json_callback({
                            "type": "transcript.partial",
                            "session_id": session_id,
                            "source_language": source_lang,
                            "text": event["text"],
                            "stability": event.get("stability", 0.8),
                            "timestamp_ms": event.get("timestamp_ms", 0)
                        })
                    elif event["type"] == "final":
                        source_text = event["text"]
                        await send_json_callback({
                            "type": "capture.status",
                            "session_id": session_id,
                            "message": "Transcription complete. Translating..."
                        })
                        await send_json_callback({
                            "type": "transcript.final",
                            "session_id": session_id,
                            "source_language": source_lang,
                            "text": source_text,
                            "start_ms": event.get("start_ms", 0),
                            "end_ms": event.get("end_ms", 0)
                        })

                        translated_text = await self.translation_provider.translate(
                            text=source_text,
                            source_lang=source_lang,
                            target_lang=target_lang
                        )

                        await send_json_callback({
                            "type": "translation.final",
                            "session_id": session_id,
                            "source_language": source_lang,
                            "target_language": target_lang,
                            "source_text": source_text,
                            "translated_text": translated_text,
                            "confidence": 0.95
                        })
            except asyncio.CancelledError:
                pass
            except Exception as e:
                await send_json_callback({
                    "type": "error",
                    "session_id": session_id,
                    "message": str(e)
                })
                print(f"Error in pipeline runner: {e}")

        runner_task = asyncio.create_task(pipeline_runner())
        return audio_queue, runner_task

