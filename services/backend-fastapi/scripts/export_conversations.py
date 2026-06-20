#!/usr/bin/env python3
"""
Export PostgreSQL conversations to JSONL format for OpenAI fine-tuning.

Handles two data layouts:
  - New turns (2026-04-09+): have conversation_id set
  - Old turns (before 2026-04-09): conversation_id=NULL; reconstructed by
    grouping turns with < 30 min gap and filtering noise rows

Usage:
    python scripts/export_conversations.py [--anonymize] [--min-turns N] [--output PATH]

Output: data/training_raw.jsonl -- one JSON object per line, OpenAI chat format.
"""
import argparse
import json
import os
import re
import sys
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

# Anonymization
PHONE_RE = re.compile(
    r'(?:\+?54\s?)?(?:11|341|342|351|261|221|223|0\d{2,4})[\s\-]?\d{3,4}[\s\-]?\d{4,6}'
)
NAME_RE = re.compile(
    r'\b(me llamo|soy|mi nombre es|llamame)\s+([A-Z\xc1\xc9\xcd\xd3\xda\xd1][a-z\xe1\xe9\xed\xf3\xfa\xf1]+(?:\s+[A-Z\xc1\xc9\xcd\xd3\xda\xd1][a-z\xe1\xe9\xed\xf3\xfa\xf1]+)?)',
    re.IGNORECASE,
)

# Old-system noise: context injection rows stored as user turns
NOISE_RE = re.compile(r'contexto acumulado|etapa=|tipo=|zona=|presupuesto=', re.IGNORECASE)

CONV_GAP = timedelta(minutes=30)

SYSTEM_PROMPT = "Sos Charlott, asesora inmobiliaria de Rosario, Argentina. Respondés en espanol rioplatense, de forma calida y directa."


def anonymize(text: str) -> str:
    if not text:
        return text
    text = PHONE_RE.sub('[TELEFONO]', text)
    text = NAME_RE.sub(lambda m: m.group(1) + ' [NOMBRE]', text)
    return text


def get_conn():
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL not set")
    return psycopg2.connect(url, cursor_factory=psycopg2.extras.RealDictCursor)


# ── Fetch linked conversations (new data) ────────────────────────────────────

def fetch_linked_conversations(conn, min_turns: int = 3) -> list:
    """Conversations where ai_turns.conversation_id IS NOT NULL."""
    cur = conn.cursor()
    cur.execute("""
        SELECT c.id, c.company_id
          FROM ai_conversations c
          JOIN ai_turns t ON t.conversation_id = c.id
         WHERE t.conversation_id IS NOT NULL
         GROUP BY c.id
        HAVING COUNT(t.id) FILTER (WHERE t.role = 'user') >= %s
    """, (min_turns,))
    convs = cur.fetchall()

    result = []
    for conv in convs:
        cid = conv["id"]
        cur.execute("""
            SELECT id, role, content, created_at
              FROM ai_turns WHERE conversation_id = %s
             ORDER BY created_at, id
        """, (cid,))
        turns = cur.fetchall()

        cur.execute("""
            SELECT turn_id, tool_name, tool_args_json, tool_result_json
              FROM ai_tool_calls WHERE conversation_id = %s
             ORDER BY created_at, id
        """, (cid,))
        tcs = cur.fetchall()
        tc_by_turn = {}
        for tc in tcs:
            tc_by_turn.setdefault(tc["turn_id"], []).append(tc)

        result.append({
            "conv_id": cid,
            "company_id": conv["company_id"],
            "turns": list(turns),
            "tool_calls_by_turn": tc_by_turn,
        })

    cur.close()
    return result


# ── Reconstruct unlinked conversations (old data) ────────────────────────────

def fetch_unlinked_conversations(conn, min_turns: int = 3) -> list:
    """
    Old turns have conversation_id=NULL. Group them into pseudo-conversations
    by time gap: > 30 min gap = new conversation. Filter noise rows.
    """
    cur = conn.cursor()
    cur.execute("""
        SELECT id, role, content, created_at
          FROM ai_turns
         WHERE conversation_id IS NULL
         ORDER BY created_at, id
    """)
    all_turns = cur.fetchall()
    cur.close()

    if not all_turns:
        return []

    # Group into pseudo-conversations by time gap
    pseudo_convs = []
    current_group = [all_turns[0]]

    for turn in all_turns[1:]:
        prev_ts = current_group[-1]["created_at"]
        curr_ts = turn["created_at"]
        if curr_ts - prev_ts > CONV_GAP:
            pseudo_convs.append(current_group)
            current_group = [turn]
        else:
            current_group.append(turn)

    if current_group:
        pseudo_convs.append(current_group)

    result = []
    for i, group in enumerate(pseudo_convs):
        # Filter noise rows (old context injection stored as user turns)
        clean_turns = [t for t in group if not NOISE_RE.search(t["content"] or "")]

        # Count real user turns
        user_turns = [t for t in clean_turns if t["role"] == "user"]
        if len(user_turns) < min_turns:
            continue

        result.append({
            "conv_id": f"legacy_{i}",
            "company_id": 1,
            "turns": clean_turns,
            "tool_calls_by_turn": {},  # old data had no tool_calls linked
        })

    return result


# ── Build OpenAI message format ───────────────────────────────────────────────

def build_openai_messages(conv: dict, do_anonymize: bool) -> list:
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    turns = conv["turns"]
    tc_by_turn = conv["tool_calls_by_turn"]

    for turn in turns:
        tid = turn["id"]
        role = turn["role"]
        content = turn["content"] or ""

        if do_anonymize:
            content = anonymize(content)

        if role == "user":
            messages.append({"role": "user", "content": content})

        elif role == "assistant":
            tcs = tc_by_turn.get(tid, [])
            if tcs:
                tc_payload = []
                for j, tc in enumerate(tcs):
                    try:
                        args = tc["tool_args_json"] if isinstance(tc["tool_args_json"], str) else json.dumps(tc["tool_args_json"] or {})
                    except Exception:
                        args = "{}"
                    tc_payload.append({
                        "id": f"call_{tid}_{j}",
                        "type": "function",
                        "function": {"name": tc["tool_name"], "arguments": args},
                    })
                messages.append({
                    "role": "assistant",
                    "content": content or None,
                    "tool_calls": tc_payload,
                })
                for j, tc in enumerate(tcs):
                    try:
                        result_text = tc["tool_result_json"] if isinstance(tc["tool_result_json"], str) else json.dumps(tc["tool_result_json"] or {})
                    except Exception:
                        result_text = "{}"
                    messages.append({
                        "role": "tool",
                        "tool_call_id": f"call_{tid}_{j}",
                        "content": result_text,
                    })
            else:
                if content:
                    messages.append({"role": "assistant", "content": content})

    return messages


def is_valid_sequence(messages: list) -> tuple:
    if len(messages) < 3:
        return False, "too_short"
    roles = [m["role"] for m in messages]
    if roles[0] != "system":
        return False, "no_system"
    if "user" not in roles:
        return False, "no_user"
    if roles[-1] != "assistant":
        return False, "bad_ending"
    last = messages[-1]
    if not last.get("content") and not last.get("tool_calls"):
        return False, "empty_assistant"
    return True, "ok"


def main():
    parser = argparse.ArgumentParser(description="Export conversations to JSONL for fine-tuning")
    parser.add_argument("--anonymize", action="store_true", help="Anonymize phone numbers and names")
    parser.add_argument("--min-turns", type=int, default=3, help="Min user turns per conversation (default: 3)")
    parser.add_argument("--output", type=str, default=str(DATA_DIR / "training_raw.jsonl"))
    args = parser.parse_args()

    conn = get_conn()
    print("[export] Connected to DB")

    linked = fetch_linked_conversations(conn, min_turns=args.min_turns)
    unlinked = fetch_unlinked_conversations(conn, min_turns=args.min_turns)
    all_convs = linked + unlinked

    print(f"[export] Linked conversations:   {len(linked)}")
    print(f"[export] Reconstructed (legacy): {len(unlinked)}")
    print(f"[export] Total:                  {len(all_convs)}")

    exported = 0
    skipped = 0
    skip_reasons = {}

    with open(args.output, "w", encoding="utf-8") as f:
        for conv in all_convs:
            messages = build_openai_messages(conv, args.anonymize)
            valid, reason = is_valid_sequence(messages)
            if not valid:
                skipped += 1
                skip_reasons[reason] = skip_reasons.get(reason, 0) + 1
                continue
            f.write(json.dumps({"messages": messages}, ensure_ascii=False) + "\n")
            exported += 1

    conn.close()

    print(f"\n[export] Results:")
    print(f"  Exported: {exported}")
    print(f"  Skipped:  {skipped}")
    for reason, count in skip_reasons.items():
        print(f"    {reason}: {count}")
    print(f"  Output: {args.output}")


if __name__ == "__main__":
    main()
