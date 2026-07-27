"""One-shot: compute embeddings for kb_chunks with empty embedding_json.

Run from services/backend-fastapi: python scripts/backfill_kb_embeddings.py
"""
import json

from sqlalchemy import text

from app.core.db import SessionLocal
from app.services.rag_service import get_openai_client

BATCH = 100


def main():
    client = get_openai_client()
    if not client:
        print("No OpenAI client (openai_api_key missing). Abort.")
        return

    db = SessionLocal()
    total = 0
    while True:
        rows = db.execute(
            text("""SELECT id, chunk_text FROM kb_chunks
                    WHERE embedding_json IS NULL OR embedding_json = '' OR embedding_json = '[]'
                    ORDER BY id LIMIT :batch"""),
            {"batch": BATCH},
        ).mappings().all()
        if not rows:
            break

        response = client.embeddings.create(
            model="text-embedding-3-small",
            input=[(r["chunk_text"] or " ")[:8000] for r in rows],
        )
        for row, data in zip(rows, response.data):
            db.execute(
                text("UPDATE kb_chunks SET embedding_json = :emb, updated_at = NOW() WHERE id = :id"),
                {"emb": json.dumps(data.embedding), "id": row["id"]},
            )
        db.commit()
        total += len(rows)
        print(f"Backfilled {total} chunks...")

    print(f"Done. {total} chunks embedded.")
    db.close()


if __name__ == "__main__":
    main()
