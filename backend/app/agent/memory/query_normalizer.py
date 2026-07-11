"""Query normalization for ProjectMemory FTS5 retrieval.

Implements AD-4 from the remediation plan:
1. Deterministic normalization, dedup, and stop-word filtering.
2. Generate strict AND and relaxed OR FTS5 expressions.
3. Compute token coverage for result ranking.

No LLM calls, no embeddings, no network calls.
"""

from __future__ import annotations

import jieba

# ─── Chinese stop words ────────────────────────────────────────────────────────
# Small, auditable list covering common function words that hurt FTS5 precision.
# Intentionally conservative: only words that are almost never meaningful in
# a project-memory retrieval context.

CHINESE_STOP_WORDS: frozenset[str] = frozenset({
    # Particles
    "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
    "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着",
    "没有", "看", "好", "自己", "这",
    # Conjunctions / prepositions
    "与", "及", "或", "但", "而", "把", "被", "让", "给", "从", "对",
    "为", "以", "于", "之", "其", "该", "此", "那",
    # Pronouns / demonstratives
    "我们", "你们", "他们", "它们", "什么", "怎么", "哪", "哪个",
    "谁", "多少", "几", "这个",
    # Auxiliaries
    "能", "可以", "应该", "需要", "必须", "可能", "已经", "正在",
    "将", "会", "要", "得",
    # Common filler in project context
    "项目", "任务", "阶段", "进行", "情况", "方面", "问题",
    "后来", "时候", "到底", "工具", "做",
    # Note: "项目" and "任务" are stop words for retrieval because they appear
    # in almost every memory and provide no discriminative power.
    # "成员" is NOT a stop word because member-specific queries are meaningful.
})

# ASCII stop words (common English function words)
ASCII_STOP_WORDS: frozenset[str] = frozenset({
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "shall",
    "should", "may", "might", "can", "could", "must", "of", "in", "on",
    "at", "to", "for", "with", "by", "from", "as", "into", "about",
    "and", "or", "not", "no", "but", "if", "then", "than", "so",
    "this", "that", "these", "those", "it", "its", "we", "you", "they",
    "what", "which", "who", "how", "when", "where", "why",
})


# User wording that maps deterministically to vocabulary used by the memory
# templates. Replacements are deliberately small and auditable; they improve
# lexical recall without pretending to provide general semantic search.
DOMAIN_TOKEN_ALIASES: dict[str, str] = {
    "有空": "可用性",
    "时间": "可用性",
    "改": "调整",
    "用": "价值",
    "难题": "问题",
    "原因": "理由",
}


def normalize_query(query: str) -> list[str]:
    """Normalize a retrieval query into meaningful tokens.

    Steps:
    1. Strip whitespace.
    2. Jieba tokenization for search.
    3. Filter stop words (Chinese and ASCII).
    4. Deduplicate while preserving order.
    5. Filter empty/whitespace-only tokens.
    """
    if not query or not query.strip():
        return []

    raw_tokens = jieba.cut_for_search(query.strip())
    seen: set[str] = set()
    result: list[str] = []

    for token in raw_tokens:
        t = token.strip()
        if not t:
            continue
        # Check stop words (case-insensitive for ASCII)
        if t in CHINESE_STOP_WORDS:
            continue
        if t.lower() in ASCII_STOP_WORDS:
            continue
        t = DOMAIN_TOKEN_ALIASES.get(t.lower(), t)
        # Single-char tokens are often noise in FTS5 AND mode
        # but we keep them for OR mode, so just dedup here
        if t not in seen:
            seen.add(t)
            result.append(t)

    return result


def build_strict_fts_query(tokens: list[str]) -> str:
    """Build a strict AND FTS5 query: all tokens must match.

    Each token is double-quoted to prevent FTS5 operator injection.
    Tokens are joined with implicit AND (space-separated in FTS5).
    """
    if not tokens:
        return ""
    return " ".join(f'"{t}"' for t in tokens)


def build_relaxed_fts_query(tokens: list[str]) -> str:
    """Build a relaxed OR FTS5 query: any token may match.

    Each token is double-quoted. Tokens are joined with OR.
    """
    if not tokens:
        return ""
    return " OR ".join(f'"{t}"' for t in tokens)


def compute_token_coverage(memory_text: str, query_tokens: list[str]) -> float:
    """Compute what fraction of query tokens appear in the memory text.

    Returns a value in [0.0, 1.0]. Used for ranking relaxed results
    to prevent a single over-broad token from dominating rank 1.
    """
    if not query_tokens:
        return 0.0
    text_lower = memory_text.lower()
    hit = sum(1 for t in query_tokens if t.lower() in text_lower)
    return hit / len(query_tokens)


def compute_substring_coverage(memory_text: str, original_query: str) -> float:
    """Compute what fraction of the original query characters are covered.

    This complements token coverage by measuring how much of the user's
    actual query text appears in the memory, which helps rank paraphrase
    queries where individual tokens are common but the full phrase is rare.

    Uses a simple sliding-window approach on the original query.
    """
    if not original_query or not memory_text:
        return 0.0
    query_lower = original_query.lower().strip()
    text_lower = memory_text.lower()
    if not query_lower:
        return 0.0

    # Try to find the longest common substring ratio
    # Simple approach: check if 2+ char substrings of query appear in text
    total_chars = len(query_lower)
    if total_chars <= 1:
        return 1.0 if query_lower in text_lower else 0.0

    # Find matched characters using greedy longest-match
    matched = 0
    i = 0
    while i < total_chars:
        # Try longest possible match from position i
        best_len = 0
        for length in range(min(total_chars - i, 20), 1, -1):
            if query_lower[i:i + length] in text_lower:
                best_len = length
                break
        if best_len > 0:
            matched += best_len
            i += best_len
        else:
            i += 1

    return matched / total_chars
