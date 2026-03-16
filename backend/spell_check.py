from autocorrect import Speller
from spellchecker import SpellChecker
from functools import lru_cache
import re

spell       = None
fast_spell  = None  # replaces sym_spell

def load_jamspell_model(model_path=None):
    global spell, fast_spell

    print("Loading Autocorrect speller...")
    spell = Speller(lang='en')
    print("Autocorrect loaded!")

    try:
        fast_spell = SpellChecker()
        print("PySpellChecker loaded successfully!")
    except ImportError:
        print("pyspellchecker not installed. Run: pip install pyspellchecker")
        fast_spell = None


@lru_cache(maxsize=10000)
def _correct_word_cached(word: str) -> str:
    """Fast single-word correction with cache."""

    # Stage 1: pyspellchecker (fast, pure Python)
    if fast_spell:
        correction = fast_spell.correction(word)
        if correction and correction != word:
            return correction

    # Stage 2: autocorrect fallback
    if spell:
        return spell(word)

    return word


@lru_cache(maxsize=512)
def _correct_sentence_cached(sentence: str) -> str:
    """Cached two-stage sentence correction."""

    # Stage 1: word-by-word fast fix (preserves punctuation/spaces)
    tokens = re.split(r'(\b\w+\b)', sentence)
    stage1_tokens = []
    for token in tokens:
        if re.match(r'^\w+$', token) and not token.isdigit():
            stage1_tokens.append(_correct_word_cached(token.lower()))
        else:
            stage1_tokens.append(token)

    stage1 = "".join(stage1_tokens)

    # Stage 2: autocorrect for context-aware correction
    if spell:
        return spell(stage1)

    return stage1


def correct_text(text: str) -> str:
    """
    Two-stage spell correction pipeline:

    Stage 1 — PySpellChecker : fast word-by-word typo fix  (pure Python, cached)
    Stage 2 — Autocorrect    : context-aware correction

    Example:
        "I havv a grate time"
        → Stage 1: "I have a grate time"   (havv → have)
        → Stage 2: "I have a great time"   (grate → great)
    """
    if not text.strip():
        return ""

    sentences = re.split(r'(?<=[.!?])\s+', text.strip())
    return " ".join(
        _correct_sentence_cached(s) for s in sentences if s.strip()
    )


def check_word(word: str) -> dict:
    """Ultra-fast single word check for real-time frontend calls."""
    if not word.strip() or not re.match(r'^\w+$', word):
        return {"word": word, "correct": True, "suggestions": []}

    clean = word.lower().strip()

    if fast_spell:
        is_correct   = clean not in fast_spell.unknown([clean])
        suggestions  = list(fast_spell.candidates(clean) or [])[:3]
    else:
        corrected    = spell(clean) if spell else clean
        is_correct   = corrected == clean
        suggestions  = [corrected] if not is_correct else []

    return {
        "word":        word,
        "correct":     is_correct,
        "suggestions": suggestions
    }


def close_spell_checker():
    global spell, fast_spell
    _correct_word_cached.cache_clear()
    _correct_sentence_cached.cache_clear()
    spell      = None
    fast_spell = None
    print("Spell checker cleared.")