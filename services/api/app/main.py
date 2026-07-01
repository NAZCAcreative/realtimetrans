import asyncio
import base64
import json
import os
import uuid
from pathlib import Path


def _load_env_file() -> None:
    """Load services/api/.env into the process environment (no dependency needed).

    Existing environment variables always win, so real OS env vars override the
    file. Runs at import time, before any provider reads os.getenv.
    """
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_env_file()

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from app.pipeline.realtime_pipeline import RealtimeTranslationPipeline
from app.pipeline.system_audio import capture_system_audio_to_queue
from app.providers.registry import registry

app = FastAPI(title="LiveSub AI API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
async def _prewarm_translation_model():
    """Optionally pre-load local NLLB.

    Cloud translation is the live default, so local model warmup is opt-in to avoid
    burning startup time and memory when it is not being used.
    """
    if os.getenv("PREWARM_LOCAL_NLLB", "0").strip().lower() not in {"1", "true", "yes", "on"}:
        print("[startup] NLLB pre-warm disabled. Set PREWARM_LOCAL_NLLB=1 to enable.")
        return
    async def _warm():
        try:
            from app.providers.local_provider import LocalNLLBTranslationProvider
            await LocalNLLBTranslationProvider().translate("warmup", "en", "ko")
            print("[startup] NLLB translation model pre-warmed.")
        except Exception as exc:
            print(f"[startup] NLLB pre-warm skipped: {exc}")

    asyncio.create_task(_warm())


@app.get("/health")
def health_check():
    return {"status": "ok", "version": "1.0.0"}

@app.websocket("/ws/audio")
async def websocket_audio_endpoint(
    websocket: WebSocket,
    stt_provider: str = Query("local_whisper"),
    translation_provider: str = Query("local_nllb"),
    source_language: str = Query("ko"),
    target_language: str = Query("en"),
    capture_segment_seconds: float = Query(0.75, gt=0.1, le=5.0),
    force_finalize_seconds: float = Query(1.0, gt=0.3, le=8.0),
    max_translate_buffer_seconds: float = Query(0.25, gt=0.05, le=3.0),
    partial_translate_interval: float = Query(0.5, gt=0.2, le=5.0),
    max_translation_lag_seconds: float = Query(4.0, gt=1.0, le=20.0)
):
    await websocket.accept()
    print(f"WebSocket client connected. STT={stt_provider}, Translation={translation_provider}")

    session_id = f"session-{uuid.uuid4().hex[:8]}"
    session_config = {
        "session_id": session_id,
        "source_language": source_language,
        "target_language": target_language,
        "force_finalize_seconds": force_finalize_seconds,
        "max_translate_buffer_seconds": max_translate_buffer_seconds,
        "partial_translate_interval": partial_translate_interval,
        "max_translation_lag_seconds": max_translation_lag_seconds,
    }

    stt = registry.get_stt(stt_provider)
    if hasattr(stt, "set_language"):
        stt.set_language(source_language)
    if hasattr(stt, "set_target_language"):
        stt.set_target_language(target_language)
    translation = registry.get_translation(translation_provider)
    pipeline = RealtimeTranslationPipeline(stt_provider=stt, translation_provider=translation)

    async def send_json_callback(data: dict):
        try:
            await websocket.send_json(data)
        except Exception as e:
            print(f"Failed to send JSON data: {e}")

    audio_queue, runner_task = await pipeline.run(
        send_json_callback=send_json_callback,
        session_config=session_config
    )
    capture_task = None

    try:
        while True:
            message = await websocket.receive_text()
            data = json.loads(message)
            msg_type = data.get("type")

            if msg_type == "capture.system.start":
                if capture_task is None or capture_task.done():
                    capture_task = asyncio.create_task(
                        capture_system_audio_to_queue(
                            audio_queue,
                            send_json_callback,
                            segment_seconds=capture_segment_seconds,
                            sample_rate=24000 if stt_provider in ("openai_realtime", "openai_realtime_translate") else 16000,
                            output_format="pcm16" if stt_provider in ("openai_realtime", "openai_realtime_translate", "gemini_live") else "wav"
                        )
                    )

            elif msg_type == "audio.chunk":
                audio_b64 = data.get("audio_base64")
                if audio_b64:
                    raw_bytes = base64.b64decode(audio_b64)
                    mime_type = data.get("mime_type", "")
                    if not mime_type.startswith("audio/pcm"):
                        await send_json_callback({
                            "type": "capture.status",
                            "message": f"Received audio segment ({len(raw_bytes) // 1024} KB). Transcribing..."
                        })
                    await audio_queue.put(raw_bytes)

            elif msg_type in {"capture.system.stop", "audio.stop"}:
                if capture_task and not capture_task.done():
                    capture_task.cancel()
                await audio_queue.put(None)
                await runner_task
                break

    except WebSocketDisconnect:
        print("WebSocket client disconnected.")
    except Exception as e:
        print(f"Error in WebSocket handler: {e}")
        await send_json_callback({"type": "error", "message": str(e)})
    finally:
        if capture_task and not capture_task.done():
            capture_task.cancel()
        if not runner_task.done():
            runner_task.cancel()
        print("WebSocket session closed and cleaned up.")




