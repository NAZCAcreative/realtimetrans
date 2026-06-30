import asyncio
import json
import os
import uuid
from typing import AsyncGenerator
from urllib import request, error

from app.providers.base import STTProvider, TranslationProvider


class OpenAIChunkedSTTProvider(STTProvider):
    def __init__(self):
        self.api_key = os.getenv("OPENAI_API_KEY", "").strip()
        self.model = os.getenv("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe")
        self.prompt = os.getenv("OPENAI_TRANSCRIBE_PROMPT", "You are transcribing audio from a video, live stream, or media player.")

    async def stream_transcribe(
        self,
        audio_stream: AsyncGenerator[bytes, None]
    ) -> AsyncGenerator[dict, None]:
        if not self.api_key:
            yield {
                "type": "final",
                "text": "OPENAI_API_KEY is not set. Add it before using live OpenAI transcription.",
                "start_ms": 0,
                "end_ms": 0,
            }
            return

        segment_index = 0
        async for chunk in audio_stream:
            if not chunk or len(chunk) < 1024:
                continue

            segment_index += 1
            text = await asyncio.to_thread(self._transcribe_chunk, chunk, segment_index)
            text = text.strip()
            if not text:
                continue

            yield {
                "type": "final",
                "text": text,
                "start_ms": segment_index * 4000,
                "end_ms": segment_index * 4000 + 4000,
            }

    def _transcribe_chunk(self, chunk: bytes, segment_index: int) -> str:
        boundary = f"----LiveSubBoundary{uuid.uuid4().hex}"
        fields = [
            ("model", self.model),
            ("response_format", "json"),
            ("prompt", self.prompt),
        ]

        body = bytearray()
        for name, value in fields:
            body.extend(f"--{boundary}\r\n".encode())
            body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
            body.extend(value.encode("utf-8"))
            body.extend(b"\r\n")

        body.extend(f"--{boundary}\r\n".encode())
        body.extend(
            f'Content-Disposition: form-data; name="file"; filename="segment-{segment_index}.webm"\r\n'.encode()
        )
        body.extend(b"Content-Type: audio/webm\r\n\r\n")
        body.extend(chunk)
        body.extend(b"\r\n")
        body.extend(f"--{boundary}--\r\n".encode())

        req = request.Request(
            "https://api.openai.com/v1/audio/transcriptions",
            data=bytes(body),
            method="POST",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
        )

        try:
            with request.urlopen(req, timeout=60) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
                return payload.get("text", "")
        except error.HTTPError as exc:
            details = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"OpenAI transcription failed: HTTP {exc.code} {details}") from exc


class OpenAITranslationProvider(TranslationProvider):
    def __init__(self):
        self.api_key = os.getenv("OPENAI_API_KEY", "").strip()
        self.model = os.getenv("OPENAI_TRANSLATE_MODEL", "gpt-4o-mini")

    async def translate(
        self,
        text: str,
        source_lang: str,
        target_lang: str,
        context: list[str] | None = None,
        glossary: dict[str, str] | None = None
    ) -> str:
        if not self.api_key:
            return "OPENAI_API_KEY is not set."

        return await asyncio.to_thread(self._translate, text, source_lang, target_lang)

    def _translate(self, text: str, source_lang: str, target_lang: str) -> str:
        payload = {
            "model": self.model,
            "input": [
                {
                    "role": "system",
                    "content": "Translate subtitles for live video. Return only the translated subtitle text. Keep names, numbers, and technical terms accurate.",
                },
                {
                    "role": "user",
                    "content": f"Translate from {source_lang} to {target_lang}:\n{text}",
                },
            ],
        }

        req = request.Request(
            "https://api.openai.com/v1/responses",
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
        )

        try:
            with request.urlopen(req, timeout=60) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
                output_text = payload.get("output_text")
                if output_text:
                    return output_text.strip()

                parts: list[str] = []
                for item in payload.get("output", []):
                    for content in item.get("content", []):
                        if content.get("type") in {"output_text", "text"}:
                            parts.append(content.get("text", ""))
                return "".join(parts).strip() or text
        except error.HTTPError as exc:
            details = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"OpenAI translation failed: HTTP {exc.code} {details}") from exc
