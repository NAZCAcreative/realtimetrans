import asyncio
import io
import wave

import numpy as np


async def capture_system_audio_to_queue(
    audio_queue: asyncio.Queue,
    send_json_callback,
    sample_rate: int = 16000,
    segment_seconds: float = 0.75,
    output_format: str = "wav",
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
        streaming = output_format == "pcm16"
        # Read in small blocks back-to-back so the loopback stream is drained
        # continuously - no sleeps, no gaps, no dropped audio. Blocks are then
        # accumulated into a segment of the requested length before dispatch.
        block_frames = max(256, int(sample_rate * min(0.1, segment_seconds)))
        segment_frames = max(block_frames, int(sample_rate * segment_seconds))
        # Avoid sending pure silence/noise to ASR. Realtime models can hallucinate
        # text when fed long runs of low-level background audio.
        silence_threshold = 0.0015
        speech_hangover_segments = 0

        pending: list[np.ndarray] = []
        pending_len = 0

        def dispatch(segment: np.ndarray):
            pcm = np.clip(segment, -1.0, 1.0)
            pcm16 = (pcm * 32767).astype(np.int16)
            if streaming:
                audio_bytes = pcm16.tobytes()
            else:
                buffer = io.BytesIO()
                with wave.open(buffer, "wb") as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(sample_rate)
                    wav.writeframes(pcm16.tobytes())
                audio_bytes = buffer.getvalue()
            # Fire-and-forget: never block the capture loop on delivery.
            asyncio.run_coroutine_threadsafe(audio_queue.put(audio_bytes), loop)

        recorder = sc.get_microphone(id=str(speaker.name), include_loopback=True).recorder(
            samplerate=sample_rate, channels=1, blocksize=block_frames
        )
        with recorder:
            while not stop_event.is_set():
                data = recorder.record(numframes=block_frames)
                if data is None or len(data) == 0:
                    continue

                mono = np.asarray(data, dtype=np.float32).reshape(-1)
                pending.append(mono)
                pending_len += len(mono)

                if pending_len < segment_frames:
                    continue

                segment = np.concatenate(pending)
                pending = []
                pending_len = 0

                peak = float(np.max(np.abs(segment))) if len(segment) else 0.0
                if peak >= silence_threshold:
                    speech_hangover_segments = 3
                elif speech_hangover_segments > 0:
                    speech_hangover_segments -= 1
                else:
                    continue

                dispatch(segment)

    task = asyncio.create_task(asyncio.to_thread(capture_worker))

    try:
        await task
    except asyncio.CancelledError:
        stop_event.set()
        await asyncio.to_thread(lambda: None)
        raise
    finally:
        stop_event.set()
