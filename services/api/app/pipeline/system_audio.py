import asyncio
import io
import time
import wave

import numpy as np


async def capture_system_audio_to_queue(
    audio_queue: asyncio.Queue,
    send_json_callback,
    sample_rate: int = 16000,
    segment_seconds: float = 2.0,
):
    try:
        import soundcard as sc
    except ImportError as exc:
        raise RuntimeError("System audio capture requires: pip install soundcard") from exc

    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    await send_json_callback({
        "type": "capture.status",
        "message": "Starting Windows system audio loopback capture",
    })

    def capture_worker():
        speaker = sc.default_speaker()
        frames_per_segment = int(sample_rate * segment_seconds)
        silent_count = 0

        with sc.get_microphone(id=str(speaker.name), include_loopback=True).recorder(samplerate=sample_rate, channels=1) as recorder:
            while not stop_event.is_set():
                data = recorder.record(numframes=frames_per_segment)

                if data is None or len(data) == 0:
                    time.sleep(0.05)
                    continue

                mono = np.asarray(data, dtype=np.float32).reshape(-1)
                if np.max(np.abs(mono)) < 0.002:
                    # MediaFoundation loopback spins fast when no audio plays.
                    # Backoff only during silence — audio processing stays unthrottled.
                    silent_count += 1
                    time.sleep(min(0.05 * silent_count, 0.5))
                    continue

                silent_count = 0

                pcm = np.clip(mono, -1.0, 1.0)
                pcm16 = (pcm * 32767).astype(np.int16)

                buffer = io.BytesIO()
                with wave.open(buffer, "wb") as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(sample_rate)
                    wav.writeframes(pcm16.tobytes())

                asyncio.run_coroutine_threadsafe(audio_queue.put(buffer.getvalue()), loop).result()

    task = asyncio.create_task(asyncio.to_thread(capture_worker))

    try:
        await task
    except asyncio.CancelledError:
        stop_event.set()
        await asyncio.to_thread(lambda: None)
        raise
    finally:
        stop_event.set()
