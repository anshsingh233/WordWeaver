from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional
import re

# Import features from your modular files
from spell_check import load_jamspell_model, correct_text, check_word, close_spell_checker
from grammar import load_grammar_tool, close_grammar_tool, check_grammar
from predictor import load_trigram_model, get_next_word, close_trigram_model
from formality import load_formality_model, predict_formality

app = FastAPI(title="Word Weaver Backend")

# ── CORS ──────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Startup & Shutdown ────────────────────────────────────────────────────────
@app.on_event("startup")
def startup_event():
    print("Starting up Word Weaver backend...")
    load_jamspell_model()                                          # spell checker
    load_grammar_tool()                                            # LanguageTool
    load_trigram_model("final.txt")                               # next-word predictor
    load_formality_model("formality_classifier_tfidf_logreg.pkl") # formality ML model
    print("All services ready!")

@app.on_event("shutdown")
def shutdown_event():
    close_grammar_tool()
    close_spell_checker()
    close_trigram_model()
    print("All services stopped.")

# ── Pydantic Models ───────────────────────────────────────────────────────────
class TextRequest(BaseModel):
    text: str

class SuggestRequest(BaseModel):
    text: str
    n: Optional[int] = 3

# ── Health Check ──────────────────────────────────────────────────────────────
@app.get("/")
def health():
    return {"status": "ok", "service": "Word Weaver API"}

# ══════════════════════════════════════════════════════════════════════════════
# ① SPELL CHECK  —  frontend calls: POST /spellcheck/text
#                                   POST /autocorrect
#                                   POST /check-word
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/spellcheck/text")
async def spellcheck_text_api(request: TextRequest):
    """
    Called by runFullSpellCheck() in script.js.
    Returns a list of misspelled words with suggestions so the
    frontend can underline them in red.
    """
    text = request.text
    if not text.strip():
        return {"errors": []}

    # Tokenise into unique words
    words = list(set(re.findall(r"\b[a-zA-Z']{2,}\b", text)))
    errors = []

    for word in words:
        result = check_word(word)
        if not result["correct"]:
            errors.append({
                "word": word,
                "suggestions": result["suggestions"]
            })

    return {"errors": errors}


@app.post("/autocorrect")
async def autocorrect_api(request: TextRequest):
    """
    Full sentence autocorrect (two-stage pipeline).
    """
    corrected = correct_text(request.text)
    return {
        "original":  request.text,
        "corrected": corrected
    }


@app.post("/check-word")
async def check_word_api(request: TextRequest):
    """
    Ultra-fast single-word check for real-time keystroke feedback.
    Automatically extracts the last word from the input text.
    """
    words = request.text.strip().split()
    word  = words[-1] if words else ""
    return check_word(word)


# ══════════════════════════════════════════════════════════════════════════════
# ② GRAMMAR  —  frontend calls: POST /grammar
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/grammar")
async def grammar_api(request: TextRequest):
    """
    Called by runGrammarCheck() in script.js.
    Returns issues list with message, context, replacements, category, severity.
    The frontend renders these in the right-hand grammar panel.
    """
    matches = check_grammar(request.text)

    # Reshape to what renderGrammarPanel() expects:
    # { message, context, replacements, category, bad_word }
    issues = []
    for m in matches:
        # Extract the erroneous word from context using offset + length
        text    = request.text
        offset  = m.get("offset", 0)
        length  = m.get("length", 0)
        bad_word = text[offset: offset + length] if length else ""

        issues.append({
            "message":      m.get("message", ""),
            "short_message": m.get("short_message", ""),
            "context":      m.get("context", ""),
            "replacements": m.get("replacements", []),
            "category":     m.get("category", ""),
            "severity":     m.get("severity", "low"),
            "offset":       offset,
            "length":       length,
            "bad_word":     bad_word,
        })

    return {
        "status":      "success",
        "error_count": len(issues),
        "issues":      issues          # ← frontend reads data.issues
    }


# ══════════════════════════════════════════════════════════════════════════════
# ③ NEXT-WORD SUGGESTIONS  —  frontend calls: POST /suggest
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/suggest")
async def suggest_api(request: SuggestRequest):
    """
    Called by fetchSuggestions() in script.js.
    Frontend sends { text, n } and expects { suggestions: [...] }.
    """
    suggestions = get_next_word(request.text, top_n=request.n or 3)
    return {"suggestions": suggestions}


# ══════════════════════════════════════════════════════════════════════════════
# ④ FORMALITY  —  frontend calls: POST /formality
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/formality")
async def formality_api(request: TextRequest):
    """
    Called by toggleFormalityCheck() in script.js.
    Frontend expects:
      { label, confidence, details: { informal_signals, formal_signals,
        avg_sentence_len }, method }
    """
    result = predict_formality(request.text)

    # If predict_formality returns a plain string, wrap it properly
    if isinstance(result, str):
        label = result.upper()
        return {
            "label":      label,
            "confidence": 80.0 if label == "FORMAL" else 65.0,
            "details": {
                "informal_signals": _count_informal(request.text),
                "formal_signals":   _count_formal(request.text),
                "avg_sentence_len": _avg_sentence_len(request.text),
            },
            "method": "ML Classifier (TF-IDF + LogReg)"
        }

    # If it already returns a dict, pass through with safe defaults
    return {
        "label":      result.get("label", "UNKNOWN"),
        "confidence": result.get("confidence", 50.0),
        "details":    result.get("details", {
            "informal_signals": _count_informal(request.text),
            "formal_signals":   _count_formal(request.text),
            "avg_sentence_len": _avg_sentence_len(request.text),
        }),
        "method": result.get("method", "ML Classifier")
    }


# ── Formality helper functions ────────────────────────────────────────────────
INFORMAL_WORDS = {
    "gonna", "wanna", "gotta", "kinda", "sorta", "yeah", "nope",
    "ok", "okay", "hey", "hi", "bye", "lol", "omg", "tbh",
    "tbf", "imo", "ngl", "btw", "stuff", "things", "like",
    "basically", "literally", "super", "pretty", "really", "very"
}

FORMAL_WORDS = {
    "therefore", "furthermore", "however", "consequently", "nevertheless",
    "notwithstanding", "henceforth", "moreover", "thus", "hence",
    "albeit", "whereas", "subsequently", "accordingly", "regarding",
    "concerning", "pursuant", "aforementioned", "hereby", "therein"
}

def _count_informal(text: str) -> int:
    words = set(re.findall(r"\b\w+\b", text.lower()))
    return len(words & INFORMAL_WORDS)

def _count_formal(text: str) -> int:
    words = set(re.findall(r"\b\w+\b", text.lower()))
    return len(words & FORMAL_WORDS)

def _avg_sentence_len(text: str) -> float:
    sentences = re.split(r"[.!?]+", text.strip())
    sentences = [s.strip() for s in sentences if s.strip()]
    if not sentences:
        return 0.0
    total_words = sum(len(s.split()) for s in sentences)
    return round(total_words / len(sentences), 1)


# ══════════════════════════════════════════════════════════════════════════════
# ⑤ LEGACY endpoints (keep for backward compatibility)
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/check-grammar")
async def check_grammar_legacy(request: TextRequest):
    """Legacy endpoint — redirects to /grammar format."""
    return await grammar_api(request)

@app.post("/predict-next")
async def predict_next_legacy(request: TextRequest):
    """Legacy endpoint."""
    suggestions = get_next_word(request.text, top_n=3)
    return {"suggestions": suggestions}

@app.post("/predict-formality")
async def predict_formality_legacy(request: TextRequest):
    """Legacy endpoint."""
    return await formality_api(request)