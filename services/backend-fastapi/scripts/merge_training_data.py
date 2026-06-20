#!/usr/bin/env python3
"""
Merge raw + golden training data, validate, estimate cost.

Usage:
    python scripts/merge_training_data.py [--golden-repeat N]

Output: data/training_final.jsonl
"""
import argparse
import json
import random
import sys
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "data"

try:
    import tiktoken
    enc = tiktoken.encoding_for_model("gpt-4o-mini")

    def count_tokens(messages: list) -> int:
        total = 0
        for m in messages:
            content = m.get("content") or ""
            if isinstance(content, str):
                total += len(enc.encode(content))
            # tool_calls and tool results
            if m.get("tool_calls"):
                for tc in m["tool_calls"]:
                    total += len(enc.encode(json.dumps(tc)))
        return total + (4 * len(messages))  # overhead per message

except ImportError:
    print("[merge] WARNING: tiktoken not installed, using char/4 approximation")

    def count_tokens(messages: list) -> int:
        total = sum(len(json.dumps(m)) for m in messages)
        return total // 4


MAX_TOKENS_PER_EXAMPLE = 16000  # OpenAI ft limit per training example


def load_jsonl(path: Path) -> list:
    if not path.exists():
        return []
    examples = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    examples.append(json.loads(line))
                except json.JSONDecodeError as e:
                    print(f"[merge] Skipping invalid line in {path}: {e}")
    return examples


def truncate_messages(messages: list, max_tokens: int) -> list:
    """Keep system + last N turns until we fit within max_tokens."""
    if count_tokens(messages) <= max_tokens:
        return messages

    system = [m for m in messages if m["role"] == "system"]
    rest = [m for m in messages if m["role"] != "system"]

    # Remove oldest non-system turns until we fit
    while rest and count_tokens(system + rest) > max_tokens:
        rest.pop(0)

    return system + rest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--golden-repeat", type=int, default=3,
                        help="Repeat golden examples N times to boost their weight (default: 3)")
    parser.add_argument("--output", type=str, default=str(DATA_DIR / "training_final.jsonl"))
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    raw_path = DATA_DIR / "training_raw.jsonl"
    golden_path = DATA_DIR / "training_golden.jsonl"

    raw = load_jsonl(raw_path)
    golden = load_jsonl(golden_path)

    print(f"[merge] Raw examples:    {len(raw)}")
    print(f"[merge] Golden examples: {len(golden)}")
    print(f"[merge] Golden repeat:   {args.golden_repeat}x")

    if not raw and not golden:
        print("[merge] ERROR: No training data found. Run export and golden scripts first.")
        sys.exit(1)

    # Build combined dataset: golden repeated N times + raw
    combined = (golden * args.golden_repeat) + raw
    print(f"[merge] Combined total:  {len(combined)} examples (before filtering)")

    # Validate and filter
    valid = []
    skipped_too_long = 0
    skipped_no_messages = 0

    token_counts = []

    for ex in combined:
        messages = ex.get("messages", [])
        if not messages:
            skipped_no_messages += 1
            continue

        tokens = count_tokens(messages)

        if tokens > MAX_TOKENS_PER_EXAMPLE:
            # Try truncation
            messages = truncate_messages(messages, MAX_TOKENS_PER_EXAMPLE)
            tokens = count_tokens(messages)
            if tokens > MAX_TOKENS_PER_EXAMPLE:
                skipped_too_long += 1
                continue
            ex = {"messages": messages}

        token_counts.append(tokens)
        valid.append(ex)

    # Shuffle
    random.seed(args.seed)
    random.shuffle(valid)

    # Write output
    output = Path(args.output)
    with open(output, "w", encoding="utf-8") as f:
        for ex in valid:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")

    # Stats
    total_tokens = sum(token_counts)
    avg_tokens = total_tokens / len(token_counts) if token_counts else 0

    # Cost estimate: OpenAI ft pricing ~$0.0080/1K tokens for gpt-4o-mini
    cost_per_1k = 0.0080
    estimated_cost = (total_tokens / 1000) * cost_per_1k

    print(f"\n[merge] Results:")
    print(f"  Valid examples:     {len(valid)}")
    print(f"  Skipped (too long): {skipped_too_long}")
    print(f"  Skipped (empty):    {skipped_no_messages}")
    print(f"  Total tokens:       {total_tokens:,}")
    print(f"  Avg tokens/example: {avg_tokens:.0f}")
    print(f"  Min tokens:         {min(token_counts) if token_counts else 0}")
    print(f"  Max tokens:         {max(token_counts) if token_counts else 0}")
    print(f"  Estimated cost:     ~${estimated_cost:.2f} USD")
    print(f"  Output:             {output}")

    if len(valid) < 10:
        print("\n[merge] WARNING: OpenAI requires at least 10 examples for fine-tuning.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
