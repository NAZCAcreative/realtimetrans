import asyncio
import base64
import json
import uuid
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

@app.get("/health")
def health_check():
    return {"status": "ok", "version": "1.0.0"}

@app.websocket("/ws/audio")
async def websocket_audio_endpoint(
    websocket: WebSocket,
    stt_provider: str = Query("local_whisper"),
    translation_provider: str = Query("local_nllb"),
    source_language: str = Query("en"),
    target_language: str = Query("ko")
):
    await websocket.accept()
    print(f"WebSocket client connected. STT={stt_provider}, Translation={translation_provider}")

    session_id = f"session-{uuid.uuid4().hex[:8]}"
    session_config = {
        "session_id": session_id,
        "source_language": source_language,
        "target_language": target_language
    }

    stt = registry.get_stt(stt_provider)
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
                        capture_system_audio_to_queue(audio_queue, send_json_callback)
                    )

            elif msg_type == "audio.chunk":
                audio_b64 = data.get("audio_base64")
                if audio_b64:
                    raw_bytes = base64.b64decode(audio_b64)
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




