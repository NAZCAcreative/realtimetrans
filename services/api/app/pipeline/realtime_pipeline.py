import asyncio
import time
from typing import AsyncGenerator
from app.providers.base import STTProvider, TranslationProvider


def detect_language(text: str) -> str | None:
    """Guess the spoken language from transcript characters."""
    if not text:
        return None
    for c in text:
        code = ord(c)
        if 0xAC00 <= code <= 0xD7AF:
            return "ko"
    for c in text:
        code = ord(c)
        if 0x3040 <= code <= 0x30FF:
            return "ja"
    for c in text:
        code = ord(c)
        if 0x4E00 <= code <= 0x9FFF:
            return "zh"
    if any(c.isalpha() and c.isascii() for c in text):
        return "en"
    return None


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
        source_lang = session_config.get("source_language", "ko")
        target_lang = session_config.get("target_language", "en")

        max_sentence_chars = int(session_config.get("max_sentence_chars", 80))
        max_buffer_seconds = float(session_config.get("max_translate_buffer_seconds", 0.9))
        translation_timeout = float(session_config.get("translation_timeout_seconds", 10.0))
        partial_interval = float(session_config.get("partial_translate_interval", 0.5))
        context_turns = int(session_config.get("context_turns", 3))
        coalesce_char_limit = int(session_config.get("coalesce_char_limit", 260))
        max_translation_attempts = int(session_config.get("max_translation_attempts", 2))
        max_translation_lag_seconds = float(session_config.get("max_translation_lag_seconds", 4.0))

        sentence_endings = (".", "!", "?", "\n", "。", "！", "？")
        provider_name = type(self.translation_provider).__name__.lower()
        partial_mode = str(session_config.get("partial_translation", "auto")).lower()
        partial_translation_enabled = (
            partial_mode in {"1", "true", "yes", "on"}
            or (partial_mode == "auto" and "openai" in provider_name)
        )

        pending_source_parts: list[str] = []
        pending_started_at = 0.0
        stop_requested = False
        last_source_lang = source_lang
        latest_partial: tuple[str, str] | None = None
        translation_history: list[tuple[str, str]] = []
        direct_partial_text = ""
        direct_partial_lang = source_lang
        direct_partial_target = target_lang
        direct_partial_at = 0.0
        direct_last_final_text = ""

        force_finalize_seconds = float(session_config.get("force_finalize_seconds", 2.0))
        min_forced_chunk_chars = int(session_config.get("min_forced_chunk_chars", 24))
        turn_committed_chars = 0
        turn_commit_time = 0.0

        auto_detect = source_lang in ("", "auto")
        detected_lang = source_lang if not auto_detect else None
        detect_sample = ""
        detect_min_chars = int(session_config.get("detect_min_chars", 12))

        translation_seq = 0
        last_sent_translation_seq = 0

        def recent_context() -> list[str]:
            return [f"{src} => {tgt}" for src, tgt in translation_history[-context_turns:]]

        translation_queue: asyncio.Queue = asyncio.Queue()

        async def audio_stream_generator() -> AsyncGenerator[bytes, None]:
            nonlocal stop_requested
            while True:
                chunk = await audio_queue.get()
                if chunk is None:
                    stop_requested = True
                    break
                yield chunk

        def should_translate(text: str) -> bool:
            stripped = text.strip()
            if not stripped:
                return False
            if stripped.endswith(sentence_endings):
                return True
            if len(stripped) >= max_sentence_chars:
                return True
            return pending_started_at > 0 and (time.monotonic() - pending_started_at) >= max_buffer_seconds

        def queue_depth() -> int:
            return translation_queue.qsize()

        async def enqueue_translation(source_text: str, lang: str, priority: str = "final"):
            nonlocal translation_seq
            text = " ".join(source_text.split())
            if not text:
                return
            translation_seq += 1
            await translation_queue.put({
                "seq": translation_seq,
                "source_text": text,
                "lang": lang,
                "attempts": 0,
                "queued_at": time.monotonic(),
                "priority": priority,
            })

        async def translate_and_send(item: dict, final_attempt: bool) -> bool:
            nonlocal last_sent_translation_seq
            source_text = item["source_text"]
            event_source_lang = item["lang"]
            seq = item["seq"]
            age = time.monotonic() - item["queued_at"]

            if age > max_translation_lag_seconds and queue_depth() > 0:
                return True

            await send_json_callback({
                "type": "capture.status",
                "session_id": session_id,
                "message": f"Translating live caption ({len(source_text)} chars)..."
            })
            try:
                translated_text = await asyncio.wait_for(
                    self.translation_provider.translate(
                        text=source_text,
                        source_lang=event_source_lang,
                        target_lang=target_lang,
                        context=recent_context(),
                    ),
                    timeout=translation_timeout,
                )
            except asyncio.CancelledError:
                raise
            except (asyncio.TimeoutError, Exception) as exc:
                reason = (f"Translation timed out after {translation_timeout:.0f}s."
                          if isinstance(exc, asyncio.TimeoutError) else str(exc))
                print(f"Translation failed ({'giving up' if final_attempt else 'will retry'}): {reason}")
                if final_attempt:
                    await send_json_callback({
                        "type": "translation.error",
                        "session_id": session_id,
                        "source_language": event_source_lang,
                        "target_language": target_lang,
                        "source_text": source_text,
                        "message": reason,
                    })
                return False

            if seq < last_sent_translation_seq:
                return True

            last_sent_translation_seq = seq
            if translated_text.strip():
                translation_history.append((source_text, translated_text))
                del translation_history[:-context_turns]

            print(f"[translate] {type(self.translation_provider).__name__} "
                  f"{event_source_lang}->{target_lang}: {source_text[:25]!r} -> {translated_text[:25]!r}")
            await send_json_callback({
                "type": "translation.final",
                "session_id": session_id,
                "source_language": event_source_lang,
                "target_language": target_lang,
                "source_text": source_text,
                "translated_text": translated_text,
                "confidence": 0.95,
                "seq": seq,
            })
            return True

        async def translation_worker():
            while True:
                item = await translation_queue.get()
                if item is None:
                    break

                # When translation falls behind, collapse backlog into the freshest
                # readable caption instead of replaying stale lines one by one.
                while not translation_queue.empty() and len(item["source_text"]) < coalesce_char_limit:
                    nxt = translation_queue.get_nowait()
                    if nxt is None:
                        await translation_queue.put(None)
                        break
                    merged = (item["source_text"] + " " + nxt["source_text"]).strip()
                    if len(merged) <= coalesce_char_limit:
                        item = {
                            **nxt,
                            "source_text": merged,
                            "attempts": min(item["attempts"], nxt["attempts"]),
                            "queued_at": min(item["queued_at"], nxt["queued_at"]),
                        }
                    else:
                        item = nxt
                        break

                final_attempt = item["attempts"] + 1 >= max_translation_attempts
                try:
                    ok = await translate_and_send(item, final_attempt)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    print(f"Translation worker error (continuing): {exc}")
                    ok = False
                if not ok and not final_attempt:
                    item["attempts"] += 1
                    item["queued_at"] = time.monotonic()
                    await asyncio.sleep(0.25)
                    await translation_queue.put(item)

        async def partial_worker():
            last_translated = ""
            while not stop_requested:
                await asyncio.sleep(partial_interval)
                snapshot = latest_partial
                if not snapshot:
                    continue
                full, lang = snapshot
                text = full[turn_committed_chars:].strip()
                if len(text) < 18 or text == last_translated:
                    continue
                try:
                    translated = await asyncio.wait_for(
                        self.translation_provider.translate(
                            text=text,
                            source_lang=lang,
                            target_lang=target_lang,
                            context=recent_context(),
                        ),
                        timeout=translation_timeout,
                    )
                except asyncio.CancelledError:
                    raise
                except Exception:
                    continue
                last_translated = text
                current_tail = ""
                if latest_partial:
                    current_tail = latest_partial[0][turn_committed_chars:].strip()
                if current_tail == text:
                    await send_json_callback({
                        "type": "translation.partial",
                        "session_id": session_id,
                        "source_language": lang,
                        "target_language": target_lang,
                        "source_text": text,
                        "translated_text": translated,
                    })

        async def flush_pending(event_source_lang: str):
            nonlocal pending_started_at
            source_text = " ".join(part.strip() for part in pending_source_parts if part.strip()).strip()
            pending_source_parts.clear()
            pending_started_at = 0.0
            if source_text:
                await enqueue_translation(source_text, event_source_lang, "final")

        def cut_at_sentence(text: str) -> int:
            best = 0
            for i, ch in enumerate(text):
                if ch in sentence_endings:
                    best = i + 1
            return best

        async def commit_turn_chunk():
            nonlocal turn_committed_chars, turn_commit_time
            snap = latest_partial
            if not snap:
                return
            full, lang = snap
            if len(full) <= turn_committed_chars or turn_commit_time <= 0:
                return
            if time.monotonic() - turn_commit_time < force_finalize_seconds:
                return
            uncommitted = full[turn_committed_chars:]
            if len(uncommitted.strip()) < min_forced_chunk_chars:
                return
            cut = cut_at_sentence(uncommitted) or len(uncommitted)
            chunk = uncommitted[:cut].strip()
            turn_committed_chars += cut
            turn_commit_time = time.monotonic()
            if chunk:
                await send_json_callback({
                    "type": "transcript.final",
                    "session_id": session_id,
                    "source_language": lang,
                    "text": chunk,
                    "start_ms": 0,
                    "end_ms": 0,
                })
                await enqueue_translation(chunk, lang, "forced")

        async def flush_direct_translation():
            nonlocal direct_partial_text, direct_last_final_text
            text = direct_partial_text.strip()
            if not text or text == direct_last_final_text:
                return
            direct_last_final_text = text
            direct_partial_text = ""
            await send_json_callback({
                "type": "translation.final",
                "session_id": session_id,
                "source_language": direct_partial_lang,
                "target_language": direct_partial_target,
                "source_text": "Live translation",
                "translated_text": text,
                "confidence": 0.9,
            })

        async def flush_timer():
            while not stop_requested:
                await asyncio.sleep(0.1)
                if (pending_source_parts and pending_started_at > 0
                        and time.monotonic() - pending_started_at >= max_buffer_seconds):
                    await flush_pending(last_source_lang)
                await commit_turn_chunk()
                if direct_partial_text and time.monotonic() - direct_partial_at >= 0.45:
                    await flush_direct_translation()

        async def consume_stt_stream():
            nonlocal pending_started_at, last_source_lang, latest_partial
            nonlocal source_lang, detected_lang, detect_sample
            nonlocal turn_committed_chars, turn_commit_time
            nonlocal direct_partial_text, direct_partial_lang, direct_partial_target, direct_partial_at, direct_last_final_text
            async for event in self.stt_provider.stream_transcribe(audio_stream_generator()):
                event_source_lang = event.get("language") or source_lang
                last_source_lang = event_source_lang

                if event["type"] == "translation_partial":
                    text = event.get("text", "").strip()
                    if text:
                        direct_partial_text = text
                        direct_partial_lang = event_source_lang
                        direct_partial_target = event.get("target_language", target_lang)
                        direct_partial_at = time.monotonic()
                        await send_json_callback({
                            "type": "translation.partial",
                            "session_id": session_id,
                            "source_language": event_source_lang,
                            "target_language": direct_partial_target,
                            "source_text": event.get("source_text", "Live translation"),
                            "translated_text": text,
                        })
                    continue

                if event["type"] == "translation_final":
                    text = event.get("text", "").strip()
                    if text:
                        direct_partial_text = ""
                        direct_last_final_text = text
                        await send_json_callback({
                            "type": "translation.final",
                            "session_id": session_id,
                            "source_language": event_source_lang,
                            "target_language": event.get("target_language", target_lang),
                            "source_text": event.get("source_text", "Live translation"),
                            "translated_text": text,
                            "confidence": 0.95,
                        })
                    continue
                if auto_detect and not detected_lang and event["type"] in ("partial", "final"):
                    detect_sample = (detect_sample + " " + event.get("text", "")).strip()
                    if len(detect_sample) >= detect_min_chars:
                        guess = detect_language(detect_sample)
                        if guess:
                            detected_lang = guess
                            source_lang = guess
                            if hasattr(self.stt_provider, "set_language"):
                                self.stt_provider.set_language(guess)
                            await send_json_callback({
                                "type": "language.detected",
                                "session_id": session_id,
                                "source_language": guess,
                            })
                            await send_json_callback({
                                "type": "capture.status",
                                "session_id": session_id,
                                "message": f"Detected language: {guess}. Reconnecting with pinned language...",
                            })
                            return

                if event["type"] == "status":
                    await send_json_callback({
                        "type": "capture.status",
                        "session_id": session_id,
                        "message": event.get("message", "Working"),
                    })
                elif event["type"] == "partial":
                    latest_partial = (event["text"], event_source_lang)
                    if turn_commit_time <= 0:
                        turn_commit_time = time.monotonic()
                    tail = event["text"][turn_committed_chars:].lstrip()
                    await send_json_callback({
                        "type": "transcript.partial",
                        "session_id": session_id,
                        "source_language": event_source_lang,
                        "text": tail,
                        "stability": event.get("stability", 0.8),
                        "timestamp_ms": event.get("timestamp_ms", 0)
                    })
                elif event["type"] == "final":
                    full_final = event["text"]
                    remaining = full_final[turn_committed_chars:] if len(full_final) > turn_committed_chars else ""
                    turn_committed_chars = 0
                    turn_commit_time = 0.0
                    latest_partial = None

                    source_text = remaining.strip()
                    if not source_text:
                        continue

                    await send_json_callback({
                        "type": "transcript.final",
                        "session_id": session_id,
                        "source_language": event_source_lang,
                        "text": source_text,
                        "start_ms": event.get("start_ms", 0),
                        "end_ms": event.get("end_ms", 0)
                    })

                    if not pending_source_parts:
                        pending_started_at = time.monotonic()
                    pending_source_parts.append(source_text)
                    combined_text = " ".join(pending_source_parts).strip()

                    if should_translate(combined_text):
                        await flush_pending(event_source_lang)

        async def pipeline_runner():
            nonlocal pending_started_at
            rapid_failures = 0
            reconnects = 0
            worker_task = asyncio.create_task(translation_worker())
            partial_task = asyncio.create_task(partial_worker()) if partial_translation_enabled else None
            flush_task = asyncio.create_task(flush_timer())
            try:
                while not stop_requested:
                    stream_started = time.monotonic()
                    try:
                        await consume_stt_stream()
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:
                        print(f"STT stream error (recovering): {exc}")
                        await send_json_callback({
                            "type": "capture.status",
                            "session_id": session_id,
                            "message": f"Transcription interrupted ({exc}). Reconnecting...",
                        })

                    if stop_requested:
                        break

                    if pending_source_parts:
                        await flush_pending(last_source_lang)

                    if time.monotonic() - stream_started < 2.0:
                        rapid_failures += 1
                    else:
                        rapid_failures = 0

                    if rapid_failures >= 5:
                        await send_json_callback({
                            "type": "error",
                            "session_id": session_id,
                            "message": "Transcription keeps failing to start. Check provider settings or API key.",
                        })
                        break

                    reconnects += 1
                    backoff = min(0.5 * rapid_failures + 0.5, 5.0)
                    await send_json_callback({
                        "type": "capture.status",
                        "session_id": session_id,
                        "message": f"Reconnecting transcription stream (#{reconnects})...",
                    })
                    await asyncio.sleep(backoff)

                if pending_source_parts:
                    await flush_pending(last_source_lang)
            except asyncio.CancelledError:
                pass
            except Exception as e:
                await send_json_callback({
                    "type": "error",
                    "session_id": session_id,
                    "message": str(e)
                })
                print(f"Error in pipeline runner: {e}")
            finally:
                flush_task.cancel()
                if partial_task:
                    partial_task.cancel()
                await translation_queue.put(None)
                try:
                    await asyncio.wait_for(worker_task, timeout=translation_timeout + 5.0)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    worker_task.cancel()

        runner_task = asyncio.create_task(pipeline_runner())
        return audio_queue, runner_task