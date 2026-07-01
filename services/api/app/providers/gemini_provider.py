import asyncio
import base64
import json
import os
import re
import time
from typing import AsyncGenerator
from urllib import parse, request, error

from app.providers.base import STTProvider, TranslationProvider, resolve_language_name


class GeminiLiveSTTProvider(STTProvider):
    """Real-time speech-to-text over the Gemini Live API (BidiGenerateContent).

    Streams 16 kHz little-endian PCM to a persistent WebSocket and reads the
    server's input-audio transcription. Structurally mirrors the OpenAI Realtime
    provider, so the pipeline's reconnect logic handles session drops.
    """

    def __init__(self):
        self.api_key = os.getenv("GEMINI_API_KEY", "").strip() or os.getenv("GOOGLE_API_KEY", "").strip()
        # Live (bidiGenerateContent) models only accept AUDIO response modality; we
        # ignore the model's audio output and read inputAudioTranscription for STT.
        self.model = os.getenv("GEMINI_LIVE_MODEL", "gemini-2.5-flash-native-audio-latest")
        self.language = self._normalize_language(os.getenv("GEMINI_LIVE_LANGUAGE", ""))

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
                "message": "GEMINI_API_KEY is not set. Add it before using Gemini Live transcription.",
            }
            return

        try:
            import websockets
        except ImportError as exc:
            raise RuntimeError("Gemini Live requires the websockets package.") from exc

        event_queue: asyncio.Queue[dict | None] = asyncio.Queue()
        uri = (
            "wss://generativelanguage.googleapis.com/ws/"
            "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
            f"?key={self.api_key}"
        )

        async with await websockets.connect(uri, max_size=None) as ws:
            model_name = self.model if self.model.startswith("models/") else f"models/{self.model}"
            lang_hint = ""
            if self.language:
                lang_hint = (
                    f" The audio is spoken in {resolve_language_name(self.language)}; "
                    "transcribe it in that language and do not translate or transliterate it."
                )
            setup = {
                "setup": {
                    "model": model_name,
                    "generationConfig": {"responseModalities": ["AUDIO"]},
                    "inputAudioTranscription": {},
                    "systemInstruction": {
                        "parts": [{
                            "text": (
                                "You are a silent real-time transcriber. Do not answer, comment on, "
                                "or respond to the audio in any way. Produce no output of your own." + lang_hint
                            )
                        }]
                    },
                }
            }
            await ws.send(json.dumps(setup))

            yield {
                "type": "status",
                "message": f"Gemini Live connecting ({self.model})...",
            }

            async def sender():
                sent = 0
                async for chunk in audio_stream:
                    if not chunk:
                        continue
                    await ws.send(json.dumps({
                        "realtimeInput": {
                            "mediaChunks": [
                                {"mimeType": "audio/pcm;rate=16000", "data": base64.b64encode(chunk).decode("ascii")}
                            ]
                        }
                    }))
                    sent += 1
                    if sent == 1 or sent % 50 == 0:
                        print(f"[GeminiLive] sent {sent} audio chunk(s) ({len(chunk)} bytes last)")

            async def receiver():
                partial_text = ""
                try:
                    async for raw in ws:
                        if isinstance(raw, (bytes, bytearray)):
                            raw = raw.decode("utf-8")
                        data = json.loads(raw)

                        if "setupComplete" in data:
                            print("[GeminiLive] setupComplete - session ready")
                            await event_queue.put({
                                "type": "status",
                                "message": "Gemini Live session ready. Speak now...",
                            })
                            continue

                        server_content = data.get("serverContent")
                        if server_content:
                            input_tx = server_content.get("inputTranscription")
                            if input_tx and input_tx.get("text"):
                                if not partial_text:
                                    print(f"[GeminiLive] inputTranscription started: {input_tx['text']!r}")
                                partial_text += input_tx["text"]
                                await event_queue.put({
                                    "type": "partial",
                                    "text": partial_text,
                                    "language": self.language or "auto",
                                })
                            if server_content.get("turnComplete"):
                                final_text = partial_text.strip()
                                partial_text = ""
                                if final_text:
                                    await event_queue.put({
                                        "type": "final",
                                        "text": final_text,
                                        "language": self.language or "auto",
                                    })

                        if "goAway" in data:
                            print(f"[GeminiLive] goAway: {data.get('goAway')}")
                            await event_queue.put({
                                "type": "status",
                                "message": "Gemini Live session ending (server goAway).",
                            })
                except Exception as exc:
                    print(f"[GeminiLive] receiver error: {exc!r}")
                    await event_queue.put({"type": "status", "message": f"Gemini Live receiver error: {exc}"})
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


class GeminiSTTProvider(STTProvider):
    """Chunked speech-to-text using Gemini's multimodal audio understanding.

    Each captured audio segment is sent to generateContent with an inline audio
    part and a transcription prompt. Best paired with system-audio capture (WAV);
    browser/tab capture produces webm which Gemini may reject.
    """

    def __init__(self):
        self.api_key = os.getenv("GEMINI_API_KEY", "").strip() or os.getenv("GOOGLE_API_KEY", "").strip()
        self.model = os.getenv("GEMINI_STT_MODEL", "gemini-2.5-flash")
        self.language = self._normalize_language(os.getenv("GEMINI_STT_LANGUAGE", ""))

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
                "type": "final",
                "text": "GEMINI_API_KEY is not set. Add it before using Gemini transcription.",
                "start_ms": 0,
                "end_ms": 0,
                "language": self.language or "auto",
            }
            return

        segment_index = 0
        async for chunk in audio_stream:
            if not chunk or len(chunk) < 1024:
                continue

            segment_index += 1
            text = await asyncio.to_thread(self._transcribe_chunk, chunk)
            text = (text or "").strip()
            if not text:
                continue

            yield {
                "type": "final",
                "text": text,
                "start_ms": segment_index * 4000,
                "end_ms": segment_index * 4000 + 4000,
                "language": self.language or "auto",
            }

    def _transcribe_chunk(self, chunk: bytes) -> str:
        mime_type = "audio/wav" if chunk[:4] == b"RIFF" else "audio/webm"
        lang_hint = f" The spoken language is {resolve_language_name(self.language)}." if self.language else ""
        prompt = (
            "Transcribe the following audio to text exactly as spoken." + lang_hint +
            " Return only the transcript with no extra commentary, labels, or quotation marks."
            " If there is no intelligible speech, return an empty response."
        )

        payload = {
            "contents": [{
                "role": "user",
                "parts": [
                    {"text": prompt},
                    {"inline_data": {"mime_type": mime_type, "data": base64.b64encode(chunk).decode("ascii")}},
                ],
            }],
            "generationConfig": {
                "temperature": 0.0,
                "maxOutputTokens": 256,
            },
        }

        model = parse.quote(self.model, safe="")
        req = request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "x-goog-api-key": self.api_key,
                "Content-Type": "application/json",
            },
        )

        try:
            with request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                parts: list[str] = []
                for candidate in data.get("candidates", []):
                    content = candidate.get("content", {})
                    for part in content.get("parts", []):
                        if "text" in part:
                            parts.append(part["text"])
                return "".join(parts).strip()
        except error.HTTPError as exc:
            details = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Gemini transcription failed: HTTP {exc.code} {details}") from exc


class GeminiTranslationProvider(TranslationProvider):
    def __init__(self):
        self.api_key = os.getenv("GEMINI_API_KEY", "").strip() or os.getenv("GOOGLE_API_KEY", "").strip()
        self.model = os.getenv("GEMINI_TRANSLATE_MODEL", "gemini-2.5-flash")

    async def translate(
        self,
        text: str,
        source_lang: str,
        target_lang: str,
        context: list[str] | None = None,
        glossary: dict[str, str] | None = None
    ) -> str:
        if not text.strip():
            return ""
        if not self.api_key:
            return "GEMINI_API_KEY is not set."

        return await asyncio.to_thread(self._translate_with_retry, text, source_lang, target_lang)


    def _translate_with_retry(self, text: str, source_lang: str, target_lang: str) -> str:
        try:
            return self._translate(text, source_lang, target_lang)
        except RuntimeError as exc:
            message = str(exc)
            if "HTTP 429" not in message:
                raise

            retry_seconds = 0
            match = re.search(r'"retryDelay"\s*:\s*"(\d+)s"', message)
            if match:
                retry_seconds = int(match.group(1))
            else:
                match = re.search(r"retry in ([0-9.]+)s", message, re.IGNORECASE)
                if match:
                    retry_seconds = int(float(match.group(1)))

            # One quick retry for very short backoffs; otherwise surface as a soft
            # error so the pipeline reports it transiently and moves on - instead of
            # blocking the translation worker or polluting captions with a fake
            # "quota exceeded" line that looks like a real translation.
            if 0 < retry_seconds <= 3:
                time.sleep(retry_seconds + 0.5)
                return self._translate(text, source_lang, target_lang)

            raise RuntimeError(
                "Gemini rate limit exceeded (free tier is ~15 requests/min, too low for "
                "continuous live translation). Switch Translation Provider to Facebook NLLB "
                "(local, unlimited) or OpenAI."
            )
    def _translate(self, text: str, source_lang: str, target_lang: str) -> str:
        payload = {
            "systemInstruction": {
                "parts": [{
                    "text": (
                        "Translate live subtitles. Return only the translated subtitle text. "
                        "Preserve names, numbers, code terms, and timing-friendly short phrasing."
                    )
                }]
            },
            "contents": [{
                "role": "user",
                "parts": [{"text": f"Translate from {resolve_language_name(source_lang)} to {resolve_language_name(target_lang)}:\n{text}"}],
            }],
            "generationConfig": {
                "temperature": 0.1,
                "maxOutputTokens": 256,
            },
        }

        model = parse.quote(self.model, safe="")
        req = request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "x-goog-api-key": self.api_key,
                "Content-Type": "application/json",
            },
        )

        try:
            with request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                parts: list[str] = []
                for candidate in data.get("candidates", []):
                    content = candidate.get("content", {})
                    for part in content.get("parts", []):
                        if "text" in part:
                            parts.append(part["text"])
                return "".join(parts).strip() or text
        except error.HTTPError as exc:
            details = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Gemini translation failed: HTTP {exc.code} {details}") from exc