import asyncio
import base64
import json
import os
from typing import AsyncGenerator

from app.providers.base import STTProvider, resolve_language_name


class OpenAIRealtimeSTTProvider(STTProvider):
    def __init__(self):
        self.api_key = os.getenv("OPENAI_API_KEY", "").strip()
        self.realtime_model = os.getenv("OPENAI_REALTIME_MODEL", "gpt-realtime-2")
        self.transcription_model = os.getenv("OPENAI_REALTIME_TRANSCRIBE_MODEL", "gpt-realtime-whisper")
        self.delay = os.getenv("OPENAI_REALTIME_TRANSCRIBE_DELAY", "minimal")
        self.language = self._normalize_language(os.getenv("OPENAI_REALTIME_TRANSCRIBE_LANGUAGE", ""))
        self.commit_interval_ms = int(os.getenv("OPENAI_REALTIME_COMMIT_INTERVAL_MS", "750"))

    def _normalize_language(self, language: str | None) -> str | None:
        language = (language or "").strip().lower()
        return None if language in ("", "auto") else language

    def set_language(self, language: str | None) -> None:
        self.language = self._normalize_language(language)

    async def stream_transcribe(
        self,
        audio_stream: AsyncGenerator[bytes, None]
    ) -> AsyncGenerator[dict, None]:
        if not self.api_key:
            yield {
                "type": "status",
                "message": "OPENAI_API_KEY is not set. Add it before using OpenAI Realtime transcription.",
            }
            return

        try:
            import websockets
        except ImportError as exc:
            raise RuntimeError("OpenAI Realtime requires the websockets package.") from exc

        event_queue: asyncio.Queue[dict | None] = asyncio.Queue()
        uri = f"wss://api.openai.com/v1/realtime?model={self.realtime_model}"
        headers = {"Authorization": f"Bearer {self.api_key}"}

        async def connect():
            try:
                return await websockets.connect(uri, extra_headers=headers, max_size=None)
            except TypeError:
                return await websockets.connect(uri, additional_headers=headers, max_size=None)

        async with await connect() as ws:
            transcription = {
                "model": self.transcription_model,
                "delay": self.delay,
            }
            if self.language:
                transcription["language"] = self.language

            await ws.send(json.dumps({
                "type": "session.update",
                "session": {
                    "type": "realtime",
                    "audio": {
                        "input": {
                            "format": {
                                "type": "audio/pcm",
                                "rate": 24000,
                            },
                            "transcription": transcription,
                            "turn_detection": None,
                        }
                    },
                },
            }))

            yield {
                "type": "status",
                "message": f"OpenAI Realtime connected ({self.transcription_model}, {self.delay}). Speak now...",
            }

            async def sender():
                buffered = False
                last_commit = asyncio.get_running_loop().time()

                async for chunk in audio_stream:
                    if not chunk:
                        continue

                    await ws.send(json.dumps({
                        "type": "input_audio_buffer.append",
                        "audio": base64.b64encode(chunk).decode("ascii"),
                    }))
                    buffered = True

                    now = asyncio.get_running_loop().time()
                    if (now - last_commit) * 1000 >= self.commit_interval_ms:
                        await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
                        buffered = False
                        last_commit = now

                if buffered:
                    await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))

            async def receiver():
                partial_text = ""
                try:
                    async for raw in ws:
                        data = json.loads(raw)
                        event_type = data.get("type")

                        if event_type == "conversation.item.input_audio_transcription.delta":
                            delta = data.get("delta", "")
                            if delta:
                                partial_text += delta
                                await event_queue.put({
                                    "type": "partial",
                                    "text": partial_text,
                                    "language": self.language or "auto",
                                })
                        elif event_type == "conversation.item.input_audio_transcription.completed":
                            transcript = data.get("transcript", "").strip()
                            if transcript:
                                partial_text = ""
                                await event_queue.put({
                                    "type": "final",
                                    "text": transcript,
                                    "language": self.language or "auto",
                                })
                        elif event_type == "error":
                            error = data.get("error", {})
                            await event_queue.put({
                                "type": "status",
                                "message": error.get("message") or json.dumps(data, ensure_ascii=False),
                            })
                        elif event_type in {"session.created", "session.updated"}:
                            await event_queue.put({
                                "type": "status",
                                "message": "OpenAI Realtime session ready.",
                            })
                finally:
                    await event_queue.put(None)

            sender_task = asyncio.create_task(sender())
            receiver_task = asyncio.create_task(receiver())

            try:
                while True:
                    event = await event_queue.get()
                    if event is None:
                        break
                    yield event
                    if sender_task.done() and event_queue.empty():
                        break
            finally:
                sender_task.cancel()
                receiver_task.cancel()


class OpenAIRealtimeTranslateProvider(STTProvider):
    """Direct live speech translation over the Realtime API.

    This provider emits translation_partial / translation_final events so the main
    pipeline can skip the separate STT -> translation API hop.
    """

    def __init__(self):
        self.api_key = os.getenv("OPENAI_API_KEY", "").strip()
        self.realtime_model = os.getenv("OPENAI_REALTIME_TRANSLATE_MODEL", "gpt-realtime-translate")
        self.source_language = self._normalize_language(os.getenv("OPENAI_REALTIME_TRANSLATE_SOURCE", ""))
        self.target_language = self._normalize_language(os.getenv("OPENAI_REALTIME_TRANSLATE_TARGET", "en")) or "en"
        self.commit_interval_ms = int(os.getenv("OPENAI_REALTIME_TRANSLATE_COMMIT_INTERVAL_MS", "500"))

    def _normalize_language(self, language: str | None) -> str | None:
        language = (language or "").strip().lower()
        return None if language in ("", "auto") else language

    def set_language(self, language: str | None) -> None:
        self.source_language = self._normalize_language(language)

    def set_target_language(self, language: str | None) -> None:
        self.target_language = self._normalize_language(language) or "en"

    def _instructions(self) -> str:
        target = resolve_language_name(self.target_language)
        source = resolve_language_name(self.source_language or "auto")
        return (
            f"You are a professional live broadcast interpreter. Listen to the incoming {source} audio "
            f"and translate it into {target} subtitles. Return only the translated subtitle text. "
            "Keep each update short, natural, and readable on screen. Do not add labels, quotes, notes, "
            "or explanations. Preserve names, numbers, technical terms, and tone."
        )

    def _extract_text(self, data: dict) -> str:
        if isinstance(data.get("delta"), str):
            return data["delta"]
        if isinstance(data.get("text"), str):
            return data["text"]
        if isinstance(data.get("transcript"), str):
            return data["transcript"]
        response = data.get("response") or {}
        if isinstance(response.get("output_text"), str):
            return response["output_text"]
        parts: list[str] = []
        for item in response.get("output", []) or data.get("output", []) or []:
            for content in item.get("content", []) or []:
                if content.get("type") in {"output_text", "text", "audio_transcript"}:
                    parts.append(content.get("text") or content.get("transcript") or "")
        return "".join(parts).strip()

    async def stream_transcribe(
        self,
        audio_stream: AsyncGenerator[bytes, None]
    ) -> AsyncGenerator[dict, None]:
        if not self.api_key:
            yield {
                "type": "status",
                "message": "OPENAI_API_KEY is not set. Add it before using OpenAI Realtime translation.",
            }
            return

        try:
            import websockets
        except ImportError as exc:
            raise RuntimeError("OpenAI Realtime requires the websockets package.") from exc

        event_queue: asyncio.Queue[dict | None] = asyncio.Queue()
        uri = f"wss://api.openai.com/v1/realtime?model={self.realtime_model}"
        headers = {"Authorization": f"Bearer {self.api_key}"}
        instructions = self._instructions()

        async def connect():
            try:
                return await websockets.connect(uri, extra_headers=headers, max_size=None)
            except TypeError:
                return await websockets.connect(uri, additional_headers=headers, max_size=None)

        async with await connect() as ws:
            await ws.send(json.dumps({
                "type": "session.update",
                "session": {
                    "type": "realtime",
                    "instructions": instructions,
                    "audio": {
                        "input": {
                            "format": {
                                "type": "audio/pcm",
                                "rate": 24000,
                            },
                            "turn_detection": None,
                        }
                    },
                },
            }))

            yield {
                "type": "status",
                "message": f"OpenAI Realtime translation connected ({self.realtime_model}). Speak now...",
            }

            async def request_translation_response():
                await ws.send(json.dumps({
                    "type": "response.create",
                    "response": {
                        "modalities": ["text"],
                        "instructions": instructions,
                    },
                }))

            async def sender():
                buffered = False
                last_commit = asyncio.get_running_loop().time()

                async for chunk in audio_stream:
                    if not chunk:
                        continue

                    await ws.send(json.dumps({
                        "type": "input_audio_buffer.append",
                        "audio": base64.b64encode(chunk).decode("ascii"),
                    }))
                    buffered = True

                    now = asyncio.get_running_loop().time()
                    if (now - last_commit) * 1000 >= self.commit_interval_ms:
                        await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
                        await request_translation_response()
                        buffered = False
                        last_commit = now

                if buffered:
                    await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
                    await request_translation_response()

            async def receiver():
                partial_text = ""
                try:
                    async for raw in ws:
                        data = json.loads(raw)
                        event_type = data.get("type")

                        if event_type in {
                            "response.output_text.delta",
                            "response.text.delta",
                            "response.audio_transcript.delta",
                            "conversation.item.output_text.delta",
                        }:
                            delta = self._extract_text(data)
                            if delta:
                                partial_text += delta
                                await event_queue.put({
                                    "type": "translation_partial",
                                    "text": partial_text.strip(),
                                    "language": self.source_language or "auto",
                                    "target_language": self.target_language,
                                })
                        elif event_type in {
                            "response.output_text.done",
                            "response.text.done",
                            "response.audio_transcript.done",
                            "response.done",
                        }:
                            final_text = self._extract_text(data) or partial_text
                            final_text = final_text.strip()
                            partial_text = ""
                            if final_text:
                                await event_queue.put({
                                    "type": "translation_final",
                                    "text": final_text,
                                    "language": self.source_language or "auto",
                                    "target_language": self.target_language,
                                })
                        elif event_type == "error":
                            error = data.get("error", {})
                            await event_queue.put({
                                "type": "status",
                                "message": error.get("message") or json.dumps(data, ensure_ascii=False),
                            })
                        elif event_type in {"session.created", "session.updated"}:
                            await event_queue.put({
                                "type": "status",
                                "message": "OpenAI Realtime translation session ready.",
                            })
                finally:
                    await event_queue.put(None)

            sender_task = asyncio.create_task(sender())
            receiver_task = asyncio.create_task(receiver())

            try:
                while True:
                    event = await event_queue.get()
                    if event is None:
                        break
                    yield event
                    if sender_task.done() and event_queue.empty():
                        break
            finally:
                sender_task.cancel()
                receiver_task.cancel()