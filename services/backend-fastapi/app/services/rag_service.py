"""
Hybrid RAG Service - Combines Full-Text Search (FTS) + OpenAI Embeddings
Retrieves top-k chunks with reranking and returns citations (chunk IDs)
"""
import json
import math
from typing import Optional
from openai import OpenAI
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import get_db


# ==================== EMBEDDINGS ====================

def get_openai_client() -> Optional[OpenAI]:
    """Get OpenAI client if API key is available"""
    if not settings.openai_api_key:
        return None
    try:
        return OpenAI(api_key=settings.openai_api_key)
    except Exception:
        return None


def get_embedding(text: str, client: OpenAI) -> list[float]:
    """Get OpenAI embedding for a single text using text-embedding-3-small"""
    try:
        response = client.embeddings.create(
            model="text-embedding-3-small",
            input=text[:8000],  # Respect token limits
        )
        return response.data[0].embedding
    except Exception as e:
        print(f"[rag] Embedding error: {e}")
        return [0.0] * 1536  # text-embedding-3-small dimension


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two vectors"""
    if not a or not b:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def vector_to_sql(vector: list[float]) -> str:
    """Convert Python vector to PostgreSQL array literal"""
    return "[" + ",".join(str(x) for x in vector) + "]"


# ==================== FTS SCORE ====================

def fts_score(chunk_text: str, query: str) -> float:
    """Compute a simple FTS relevance score based on term frequency"""
    query_terms = query.lower().split()
    chunk_lower = chunk_text.lower()
    if not query_terms:
        return 0.0
    matches = sum(1 for term in query_terms if term in chunk_lower)
    return matches / len(query_terms)


# ==================== RAG SEARCH ====================

class RAGService:
    """
    Hybrid RAG: combines FTS + vector similarity with reranking.
    Returns top-k results with chunk IDs for citations.
    """

    def __init__(self, company_id: int = 1):
        self.company_id = company_id
        self.client = get_openai_client()
        self._db_gen = None

    def _get_db(self) -> Session:
        """Get a fresh DB session"""
        if self._db_gen is None:
            self._db_gen = get_db()
        try:
            return next(self._db_gen)
        except StopIteration:
            self._db_gen = get_db()
            return next(self._db_gen)

    def search(
        self,
        query: str,
        top_k: int = 10,
        category: Optional[str] = None,
        return_chunks: bool = True,
    ) -> dict:
        """
        Hybrid RAG search combining FTS and embeddings.
        
        Returns:
            {
                "results": [{"chunk_id", "document_id", "chunk_text", "title", "category", "score", "rerank_score"}],
                "query_embedding": [...],
                "total_chunks_searched": int,
                "fts_used": bool,
                "embedding_used": bool,
            }
        """
        if not query or not query.strip():
            return {"results": [], "query_embedding": [], "total_chunks_searched": 0, "fts_used": False, "embedding_used": False}

        query = query.strip()
        
        # Get DB session
        db = self._get_db()

        # Build FTS query (PostgreSQL tsquery)
        fts_query = self._build_fts_query(query)
        
        # Build WHERE clause
        where_clauses = ["d.company_id = :company_id", "d.status IN ('active', 'ready')"]
        params = {"company_id": self.company_id, "query": query, "fts_query": fts_query}
        
        if category:
            where_clauses.append("d.category = :category")
            params["category"] = category

        where_sql = " AND ".join(where_clauses)

        # Fetch candidate chunks with FTS ranking
        try:
            rows = db.execute(
                text(f"""
                    SELECT 
                        c.id AS chunk_id,
                        c.document_id,
                        c.chunk_text,
                        d.title,
                        d.category,
                        COALESCE(c.embedding_json, '[]') AS embedding_json,
                        ts_rank(
                            to_tsvector('spanish', c.chunk_text),
                            to_tsquery('spanish', :fts_query)
                        ) AS fts_rank,
                        ts_rank(
                            to_tsvector('spanish', d.title || ' ' || c.chunk_text),
                            to_tsquery('spanish', :fts_query)
                        ) AS title_fts_rank
                    FROM kb_chunks c
                    JOIN kb_documents d ON d.id = c.document_id
                    WHERE {where_sql}
                    ORDER BY fts_rank DESC, title_fts_rank DESC, c.id DESC
                    LIMIT :top_k
                """),
                {**params, "top_k": top_k * 4}  # Fetch 4x for reranking
            ).mappings().all()
        except Exception as e:
            print(f"[rag] FTS query error: {e}")
            rows = []

        # Compute query embedding
        query_embedding = []
        embedding_used = False
        if self.client and rows:
            query_embedding = get_embedding(query, self.client)
            embedding_used = True

        # Score candidates: hybrid FTS + embedding
        candidates = []
        for row in rows:
            chunk_text = row["chunk_text"] or ""
            
            # FTS score (normalize 0-1 from ts_rank)
            raw_fts = float(row["fts_rank"] or 0) + float(row["title_fts_rank"] or 0) * 1.5
            fts_score_val = min(1.0, raw_fts / 0.5) if raw_fts > 0 else 0.0
            
            # Embedding similarity
            embedding_sim = 0.0
            if query_embedding and row["embedding_json"]:
                try:
                    chunk_emb = json.loads(row["embedding_json"])
                    if isinstance(chunk_emb, list) and len(chunk_emb) > 0:
                        embedding_sim = cosine_similarity(query_embedding, chunk_emb)
                except (json.JSONDecodeError, TypeError):
                    pass
            
            # Hybrid score: weighted combination
            # Give more weight to embedding similarity when available
            if embedding_sim > 0:
                hybrid_score = (0.4 * fts_score_val) + (0.6 * embedding_sim)
            else:
                hybrid_score = fts_score_val

            candidates.append({
                "chunk_id": row["chunk_id"],
                "document_id": row["document_id"],
                "chunk_text": chunk_text,
                "title": row["title"],
                "category": row["category"],
                "fts_score": round(fts_score_val, 4),
                "embedding_score": round(embedding_sim, 4),
                "hybrid_score": round(hybrid_score, 4),
            })

        # Re-rank: sort by hybrid score
        candidates.sort(key=lambda x: x["hybrid_score"], reverse=True)

        # Take top-k
        top_results = candidates[:top_k]

        # Format output
        results = []
        for r in top_results:
            if return_chunks:
                results.append({
                    "chunk_id": r["chunk_id"],
                    "document_id": r["document_id"],
                    "chunk_text": r["chunk_text"],
                    "title": r["title"],
                    "category": r["category"],
                    "score": r["hybrid_score"],
                    "fts_score": r["fts_score"],
                    "embedding_score": r["embedding_score"],
                })
            else:
                results.append({
                    "chunk_id": r["chunk_id"],
                    "document_id": r["document_id"],
                    "title": r["title"],
                    "category": r["category"],
                    "score": r["hybrid_score"],
                    "snippet": r["chunk_text"][:200] + "..." if len(r["chunk_text"]) > 200 else r["chunk_text"],
                })

        # Collect chunk IDs for citations
        cited_chunk_ids = [str(r["chunk_id"]) for r in results]

        return {
            "results": results,
            "cited_chunk_ids": cited_chunk_ids,
            "query_embedding": query_embedding,
            "total_chunks_searched": len(rows),
            "fts_used": True,
            "embedding_used": embedding_used,
            "num_results": len(results),
        }

    def _build_fts_query(self, query: str) -> str:
        """Convert natural language query to PostgreSQL tsquery"""
        # Remove special chars, split into terms
        import re
        terms = re.findall(r'\b\w+\b', query.lower())
        # Keep terms with 2+ chars
        terms = [t for t in terms if len(t) >= 2]
        if not terms:
            return query.lower()
        # Join with & (AND) for strict matching
        return " & ".join(terms)

    def get_context_for_prompt(
        self,
        query: str,
        max_chars: int = 4000,
        top_k: int = 5,
    ) -> tuple[str, list[dict]]:
        """
        Get formatted KB context for LLM prompt + citation metadata.
        
        Returns:
            (context_string, citations_list)
        """
        search_result = self.search(query=query, top_k=top_k)

        if not search_result["results"]:
            return "", []

        citations = []
        context_parts = []
        total_chars = 0

        for i, r in enumerate(search_result["results"], 1):
            chunk_text = r["chunk_text"]
            chunk_len = len(chunk_text)

            if total_chars + chunk_len > max_chars:
                # Don't split a chunk, skip if we're over limit
                break

            chunk_id_str = f"[CIT-{r['chunk_id']}]"
            part = f"--- Documento: {r['title']} {chunk_id_str} ---\n{chunk_text}"
            context_parts.append(part)

            citations.append({
                "chunk_id": r["chunk_id"],
                "document_id": r["document_id"],
                "title": r["title"],
                "category": r["category"],
                "score": r["score"],
                "citation": chunk_id_str,
            })

            total_chars += len(part) + 2

        context_str = "\n\n".join(context_parts)

        return context_str, citations

    def log_search(
        self,
        db: Session,
        query: str,
        top_k: int,
        results_json: str,
        cited_chunk_ids: list[str],
    ) -> None:
        """Log search to kb_search_logs table for analytics"""
        try:
            db.execute(
                text("""
                    INSERT INTO kb_search_logs 
                    (company_id, query, top_k, results_json, cited_chunk_ids, created_at, updated_at)
                    VALUES (:company_id, :query, :top_k, :results_json, :cited_chunk_ids, NOW(), NOW())
                """),
                {
                    "company_id": self.company_id,
                    "query": query,
                    "top_k": top_k,
                    "results_json": results_json,
                    "cited_chunk_ids": json.dumps(cited_chunk_ids),
                },
            )
            db.commit()
        except Exception as e:
            print(f"[rag] Failed to log search: {e}")


# ==================== STANDALONE FUNCTIONS ====================

def hybrid_search(
    query: str,
    company_id: int = 1,
    top_k: int = 5,
    category: Optional[str] = None,
) -> dict:
    """Standalone function for simple RAG search"""
    rag = RAGService(company_id=company_id)
    return rag.search(query=query, top_k=top_k, category=category)


def get_kb_context_for_prompt(
    query: str,
    company_id: int = 1,
    max_chars: int = 4000,
    top_k: int = 5,
) -> tuple[str, list[dict]]:
    """Standalone function to get KB context for prompt injection"""
    rag = RAGService(company_id=company_id)
    return rag.get_context_for_prompt(query=query, max_chars=max_chars, top_k=top_k)
