import language_tool_python
import re
import concurrent.futures
from functools import lru_cache

tool = None

# -------------------------------------------------------------------
# Categories to ignore (minor/cosmetic issues)
# -------------------------------------------------------------------
IGNORE_CATEGORIES = {"WHITESPACE", "TYPOGRAPHY", "PUNCTUATION"}

# -------------------------------------------------------------------
# Load / Close
# -------------------------------------------------------------------
def load_grammar_tool():
    global tool
    try:
        print("Initializing LanguageTool...")
        tool = language_tool_python.LanguageTool('en-US')
        print("LanguageTool initialized successfully!")
    except Exception as e:
        print(f"Failed to initialize LanguageTool: {e}")
        tool = None

def close_grammar_tool():
    global tool
    if tool is not None:
        try:
            tool.close()
            print("LanguageTool closed safely.")
        except Exception as e:
            print(f"Error closing LanguageTool: {e}")
        finally:
            tool = None
            check_grammar_cached.cache_clear()
            print("Grammar cache cleared.")

# -------------------------------------------------------------------
# Core single-sentence checker (used internally)
# -------------------------------------------------------------------
def _check_single(sentence: str) -> list:
    """Check grammar for a single sentence. Used by parallel checker."""
    if not sentence.strip() or tool is None:
        return []

    try:
        matches = tool.check(sentence)
        results = []

        for match in matches:
            # Filter out minor/cosmetic categories
            category = getattr(match, 'category', '')
            if category in IGNORE_CATEGORIES:
                continue

            # Determine severity based on category
            severity = _get_severity(category)

            results.append({
                "message":       getattr(match, 'message', ''),
                "short_message": getattr(match, 'shortMessage',
                                 getattr(match, 'short_message',
                                 getattr(match, 'category', ''))),
                "offset":        getattr(match, 'offset', 0),
                "length":        getattr(match, 'errorLength',
                                 getattr(match, 'matchedLength', 0)),
                "replacements":  getattr(match, 'replacements', [])[:5],
                "context":       getattr(match, 'context', ''),
                "category":      category,
                "severity":      severity,
            })

        return results

    except Exception as e:
        print(f"Grammar check failed on sentence: {e}")
        return []


def _get_severity(category: str) -> str:
    """Classify error severity based on category."""
    high   = {"GRAMMAR", "AGREEMENT", "VERB_FORM"}
    medium = {"SPELLING", "CONFUSED_WORDS", "REDUNDANCY"}
    # everything else → low
    if category in high:
        return "high"
    elif category in medium:
        return "medium"
    else:
        return "low"

# -------------------------------------------------------------------
# Cached wrapper (avoids re-checking identical sentences)
# -------------------------------------------------------------------
@lru_cache(maxsize=256)
def check_grammar_cached(text: str) -> tuple:
    """
    LRU-cached version of grammar check.
    Returns a tuple of result dicts (tuples are hashable for lru_cache).
    """
    return tuple(str(r) for r in _check_single(text))


# -------------------------------------------------------------------
# Main public function — parallel sentence-by-sentence checking
# -------------------------------------------------------------------
def check_grammar(text: str) -> list:
    global tool

    if not text.strip():
        return []

    if tool is None:
        print("Grammar tool is not initialized.")
        return []

    # Split into sentences for parallel processing
    sentences = re.split(r'(?<=[.!?])\s+', text.strip())

    all_errors = []

    # Use threading for parallel sentence checking
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        futures = {
            executor.submit(_check_single, sentence): (idx, sentence)
            for idx, sentence in enumerate(sentences)
        }

        # Track character offset per sentence
        sentence_offsets = {}
        offset = 0
        for i, sentence in enumerate(sentences):
            sentence_offsets[i] = offset
            offset += len(sentence) + 1  # +1 for the space/newline

        for future in concurrent.futures.as_completed(futures):
            idx, sentence = futures[future]
            try:
                errors = future.result()
                for error in errors:
                    # Adjust offset relative to full text position
                    error["offset"] += sentence_offsets[idx]
                    all_errors.append(error)
            except Exception as e:
                print(f"Parallel grammar check error: {e}")

    # Sort errors by their position in the text
    all_errors.sort(key=lambda x: x["offset"])
    return all_errors