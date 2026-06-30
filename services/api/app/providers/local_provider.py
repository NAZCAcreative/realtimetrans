import asyncio
import os
import tempfile
from pathlib import Path
from typing import AsyncGenerator

from app.providers.base import STTProvider, TranslationProvider


class LocalWhisperSTTProvider(STTProvider):
    _model = None

    def __init__(self):
        self.model_name = os.getenv("LOCAL_WHISPER_MODEL", "large-v3-turbo")
        self.device = os.getenv("LOCAL_WHISPER_DEVICE", "").strip()
        self.compute_type = os.getenv("LOCAL_WHISPER_COMPUTE_TYPE", "").strip()
        if not self.device or not self.compute_type:
            self.device, self.compute_type = self._resolve_whisper_runtime()
        self.beam_size = int(os.getenv("LOCAL_WHISPER_BEAM_SIZE", "1"))
        self.language = os.getenv("LOCAL_WHISPER_LANGUAGE", "") or None
        # VAD was over-filtering quiet / non-clean speech, leaving every segment empty
        # (the UI then hangs on "Transcribing..."). Make it tunable and less aggressive.
        self.vad_filter = os.getenv("LOCAL_WHISPER_VAD", "true").strip().lower() not in ("false", "0", "off")
        self.no_speech_threshold = float(os.getenv("LOCAL_WHISPER_NO_SPEECH_THRESHOLD", "0.45"))

    def _resolve_whisper_runtime(self) -> tuple[str, str]:
        try:
            import ctranslate2
            if ctranslate2.get_cuda_device_count() > 0:
                return "cuda", "float16"
        except Exception:
            pass
        return "cpu", "int8"

    async def stream_transcribe(
        self,
        audio_stream: AsyncGenerator[bytes, None]
    ) -> AsyncGenerator[dict, None]:
        segment_index = 0

        async for chunk in audio_stream:
            if not chunk or len(chunk) < 1024:
                continue

            segment_index += 1
            text = (await asyncio.to_thread(self._transcribe_chunk, chunk)).strip()
            if not text:
                # Surface this instead of silently swallowing it, so the UI does not
                # look frozen on "Transcribing..." when a segment has no speech.
                yield {
                    "type": "status",
                    "message": "No speech detected in the last segment — still listening...",
                }
                continue

            yield {
                "type": "final",
                "text": text,
                "start_ms": segment_index * 3500,
                "end_ms": segment_index * 3500 + 3500,
            }

    def _load_model(self):
        if LocalWhisperSTTProvider._model is not None:
            return LocalWhisperSTTProvider._model

        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise RuntimeError(
                "Local Whisper is not installed. Install backend dependencies: "
                "pip install faster-whisper"
            ) from exc

        print(f"[Whisper] Loading {self.model_name} on {self.device}/{self.compute_type}")
        try:
            model = WhisperModel(
                self.model_name,
                device=self.device,
                compute_type=self.compute_type,
            )
        except Exception as e:
            if self.device != "cpu":
                print(f"[Whisper] {self.device}/{self.compute_type} failed ({e!r}), retrying on CPU/int8")
                self.device = "cpu"
                self.compute_type = "int8"
                model = WhisperModel(self.model_name, device="cpu", compute_type="int8")
            else:
                raise

        print(f"[Whisper] Model ready on {self.device}/{self.compute_type}")
        LocalWhisperSTTProvider._model = model
        return LocalWhisperSTTProvider._model

    def _transcribe_chunk(self, chunk: bytes) -> str:
        model = self._load_model()
        tmp_path = ""

        try:
            suffix = ".wav" if chunk[:4] == b"RIFF" else ".webm"
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                tmp.write(chunk)
                tmp_path = tmp.name

            segments, _info = model.transcribe(
                tmp_path,
                language=None if self.language == "auto" else self.language,
                beam_size=self.beam_size,
                vad_filter=self.vad_filter,
                condition_on_previous_text=False,
                no_speech_threshold=self.no_speech_threshold,
            )
            return " ".join(segment.text.strip() for segment in segments if segment.text.strip())
        finally:
            if tmp_path:
                Path(tmp_path).unlink(missing_ok=True)


class LocalNLLBTranslationProvider(TranslationProvider):
    _tokenizer = None
    _model = None
    _device = None

    LANG_CODES = {
        "auto": "eng_Latn",
        "en": "eng_Latn",
        "ko": "kor_Hang",
        "ja": "jpn_Jpan",
        "zh": "zho_Hans",
        "es": "spa_Latn",
        "fr": "fra_Latn",
        "de": "deu_Latn",
    }

    def __init__(self):
        self.model_name = os.getenv("LOCAL_TRANSLATION_MODEL", "facebook/nllb-200-distilled-600M")
        self.max_new_tokens = int(os.getenv("LOCAL_TRANSLATION_MAX_NEW_TOKENS", "160"))

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

        return await asyncio.to_thread(self._translate, text, source_lang, target_lang)

    def _load_model(self):
        if LocalNLLBTranslationProvider._model is not None:
            return (
                LocalNLLBTranslationProvider._tokenizer,
                LocalNLLBTranslationProvider._model,
                LocalNLLBTranslationProvider._device,
            )

        try:
            import torch
            from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
        except ImportError as exc:
            raise RuntimeError(
                "Local NLLB translation is not installed. Install backend dependencies: "
                "pip install torch transformers sentencepiece"
            ) from exc

        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"[NLLB] Loading {self.model_name} on {device}")
        tokenizer = AutoTokenizer.from_pretrained(self.model_name)
        model = AutoModelForSeq2SeqLM.from_pretrained(self.model_name)
        model.to(device)
        model.eval()
        print(f"[NLLB] Model ready on {device}")

        LocalNLLBTranslationProvider._tokenizer = tokenizer
        LocalNLLBTranslationProvider._model = model
        LocalNLLBTranslationProvider._device = device
        return tokenizer, model, device

    def _translate(self, text: str, source_lang: str, target_lang: str) -> str:
        import torch

        tokenizer, model, device = self._load_model()
        src_code = self.LANG_CODES.get(source_lang, source_lang)
        tgt_code = self.LANG_CODES.get(target_lang, target_lang)

        tokenizer.src_lang = src_code
        inputs = tokenizer(text, return_tensors="pt", truncation=True, max_length=512).to(device)
        forced_bos_token_id = tokenizer.convert_tokens_to_ids(tgt_code)

        with torch.no_grad():
            output_tokens = model.generate(
                **inputs,
                forced_bos_token_id=forced_bos_token_id,
                max_new_tokens=self.max_new_tokens,
                num_beams=1,
            )

        return tokenizer.batch_decode(output_tokens, skip_special_tokens=True)[0].strip()



