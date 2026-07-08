import os


def _parse_glossary(raw: str) -> list[tuple[str, str]]:
    entries: list[tuple[str, str]] = []
    for part in raw.replace("\n", ",").split(","):
        item = part.strip()
        if not item or "=" not in item:
            continue
        wrong, right = item.split("=", 1)
        wrong = wrong.strip()
        right = right.strip()
        if wrong and right and wrong != right:
            entries.append((wrong, right))
    return entries


def _normalize_language(language: str | None) -> str:
    return (language or "").strip().lower()


_COMMON_ASR_REPLACEMENTS = [
    ("오픈 에이아이", "OpenAI"),
    ("오픈AI", "OpenAI"),
    ("지피티", "GPT"),
    ("쥐피티", "GPT"),
    ("리얼 타임", "Realtime"),
    ("리얼타임", "Realtime"),
    ("웹 소켓", "WebSocket"),
    ("웹소켓", "WebSocket"),
    ("에이피아이", "API"),
    ("유알엘", "URL"),
    ("유아이", "UI"),
    ("유엑스", "UX"),
    ("탭 윈도우", "Tab / Window"),
    ("open ai", "OpenAI"),
    ("Open AI", "OpenAI"),
    ("chat gpt", "ChatGPT"),
    ("Chat GPT", "ChatGPT"),
    ("g p t", "GPT"),
    ("G P T", "GPT"),
    ("web socket", "WebSocket"),
    ("Web Socket", "WebSocket"),
    ("オープンAI", "OpenAI"),
    ("オープンエーアイ", "OpenAI"),
    ("チャットGPT", "ChatGPT"),
    ("チャットジーピーティー", "ChatGPT"),
    ("ジーピーティー", "GPT"),
    ("リアルタイム", "Realtime"),
    ("ウェブソケット", "WebSocket"),
    ("エーピーアイ", "API"),
    ("ユーアールエル", "URL"),
]


def asr_prompt(language: str | None = None) -> str:
    terms = os.getenv("ASR_BIAS_TERMS", "").strip()
    lang = _normalize_language(language)

    core_rules = (
        "You are a real-time ASR post-processing engine. Restore the speaker's actual words as accurately as possible. "
        "Accuracy is more important than word choice, grammar, or naturalness. Do not rewrite the meaning, summarize, translate, "
        "or invent missing words. If speech is unclear, mark it as [inaudible] or [word?]. "
        "Handle fast speech, quiet voices, laughter, overlapping speakers, microphone noise, breath sounds, mumbling, regional accents, "
        "English-style pronunciation, Korean spoken by non-native speakers, Korean-accented English, streaming, meetings, games, movies, "
        "YouTube, Discord, and Zoom audio. Use recent context only to fix homophones, impossible words, and obvious ASR confusions. "
        "Preserve brands, companies, games, people, countries, cities, API names, programming languages, libraries, model names, acronyms, "
        "and product names such as GPT-5.5, Gemini 2.5, Claude, FastAPI, Next.js, Supabase, PostgreSQL, Docker, Kubernetes, OpenAI, "
        "Anthropic, Google Cloud, Azure, AWS, GitHub, API, CPU, GPU, RAM, USB, HTTP, HTTPS, JSON, REST, JWT, and OAuth. "
        "Normalize numbers when the meaning is clear, for example twenty twenty six as 2026, three point five as 3.5, "
        "and one hundred thousand as 100000. Add natural punctuation and line breaks by meaning unit. "
        "Remove filler words such as 음, 어, 그, 저, 이제, 막, 약간, 그러니까 when they are only speech habits, but preserve repeated words used for emphasis. "
        "Support Korean, English, Japanese, Chinese, and mixed-language speech. Keep each language as spoken."
    )

    if lang == "en":
        base = (
            "Transcribe English speech in English. Preserve Korean, Japanese, Chinese, or other inserted words exactly as spoken. "
            + core_rules
        )
    elif lang == "ja":
        base = (
            "日本語の音声を、自然な句読点つきの日本語文として正確に書き起こしてください。"
            "翻訳せず、聞き取れない内容は [inaudible] または [word?] として示してください。"
            + core_rules
        )
    elif lang == "ko":
        base = (
            "한국어 음성을 화자의 실제 발화에 최대한 가깝게 전사하세요. "
            "조사, 어미, 띄어쓰기, 숫자, 영문 약어, 제품명, 사람 이름, 음식명, 메뉴명을 보존하세요. "
            + core_rules
        )
    else:
        base = (
            "Automatically detect the spoken language and transcribe in the original language. "
            + core_rules
        )

    if terms:
        base += f" Frequent terms: {terms}."
    return base


def korean_asr_prompt() -> str:
    return asr_prompt("ko")


def apply_asr_glossary(text: str, language: str | None = None) -> str:
    if not text:
        return text
    fixed = text
    lang = _normalize_language(language)
    replacements = [] if lang == "ko" else list(_COMMON_ASR_REPLACEMENTS)
    if lang and lang != "ko":
        replacements.extend(_parse_glossary(os.getenv(f"ASR_GLOSSARY_{lang.upper()}", "")))
    if lang != "ko":
        replacements.extend(_parse_glossary(os.getenv("ASR_GLOSSARY", "")))
    for wrong, right in replacements:
        fixed = fixed.replace(wrong, right)
    return " ".join(fixed.split())
