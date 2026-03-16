from collections import defaultdict, Counter
import re
from functools import lru_cache

# -------------------------------------------------------------------
# Data Stores
# -------------------------------------------------------------------
unigrams   = Counter()
bigrams    = defaultdict(Counter)
trigrams   = defaultdict(Counter)

# Trie for prefix/mid-word matching
class TrieNode:
    __slots__ = ('children', 'word', 'count')  # memory optimization
    def __init__(self):
        self.children = {}
        self.word     = None   # stores full word at terminal node
        self.count    = 0

class Trie:
    def __init__(self):
        self.root = TrieNode()

    def insert(self, word: str, count: int):
        node = self.root
        for ch in word:
            if ch not in node.children:
                node.children[ch] = TrieNode()
            node = node.children[ch]
        node.word  = word
        node.count = count

    def search_prefix(self, prefix: str, top_n: int = 3) -> list:
        node = self.root
        for ch in prefix:
            if ch not in node.children:
                return []
            node = node.children[ch]

        # BFS to collect completions
        results = []
        stack   = [node]
        while stack:
            cur = stack.pop()
            if cur.word:
                results.append((cur.word, cur.count))
            for child in cur.children.values():
                stack.append(child)

        results.sort(key=lambda x: -x[1])
        return [w for w, _ in results[:top_n]]

trie = Trie()

# -------------------------------------------------------------------
# Load Model
# -------------------------------------------------------------------
def load_trigram_model(file_path: str = "final.txt"):
    global unigrams, bigrams, trigrams, trie

    print(f"Building Trigram model from {file_path}...")

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            text = f.read().lower()

        words = re.findall(r'\b\w+\b', text)

        # Build n-gram frequency maps
        for i, w in enumerate(words):
            unigrams[w] += 1
            if i >= 1: bigrams[words[i - 1]][w]              += 1
            if i >= 2: trigrams[(words[i - 2], words[i - 1])][w] += 1

        # Build Trie from unigrams
        for word, count in unigrams.items():
            trie.insert(word, count)

        print(f"Model ready — {len(trigrams)} trigrams | "
              f"{len(bigrams)} bigrams | {len(unigrams)} unigrams")

    except FileNotFoundError:
        print(f"ERROR: '{file_path}' not found.")

# -------------------------------------------------------------------
# Prediction (with Stupid Backoff: trigram → bigram → unigram)
# -------------------------------------------------------------------
@lru_cache(maxsize=512)
def _predict_cached(last_two: tuple, top_n: int) -> list:
    w1, w2 = last_two

    # 1. Try trigram
    if (w1, w2) in trigrams and trigrams[(w1, w2)]:
        return [w for w, _ in trigrams[(w1, w2)].most_common(top_n)]

    # 2. Fallback to bigram
    if w2 in bigrams and bigrams[w2]:
        return [w for w, _ in bigrams[w2].most_common(top_n)]

    # 3. Fallback to unigram
    return [w for w, _ in unigrams.most_common(top_n)]


def get_next_word(text: str, top_n: int = 3) -> list:
    """
    Returns up to top_n next-word suggestions.
    
    Handles two cases:
    - Complete word typed  → predict next word   e.g. "I am"    → ["going", "sure", "not"]
    - Partial word typed   → complete the word   e.g. "I am go" → ["going", "gone", "good"]
    """
    words = re.findall(r'\b\w+\b', text.lower())

    if not words:
        return []

    last_token = text.rstrip()

    # --- Case 1: Text ends with a space → predict NEXT word ---
    if text.endswith(" "):
        if len(words) >= 2:
            return _predict_cached((words[-2], words[-1]), top_n)
        elif len(words) == 1:
            w = words[-1]
            if w in bigrams:
                return [x for x, _ in bigrams[w].most_common(top_n)]
        return [w for w, _ in unigrams.most_common(top_n)]

    # --- Case 2: Text ends mid-word → complete current word via Trie ---
    partial = words[-1]
    trie_results = trie.search_prefix(partial, top_n)
    if trie_results:
        return trie_results

    # --- Fallback: treat partial as complete, predict next ---
    if len(words) >= 2:
        return _predict_cached((words[-2], words[-1]), top_n)

    return []


def close_trigram_model():
    """Clear memory on shutdown."""
    global unigrams, bigrams, trigrams, trie
    unigrams.clear()
    bigrams.clear()
    trigrams.clear()
    trie = Trie()
    _predict_cached.cache_clear()
    print("Trigram model cleared.")