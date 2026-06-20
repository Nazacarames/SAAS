#!/usr/bin/env python3
"""
Weekly auto-retrain script for Charlott fine-tuning pipeline.
Runs as cron: 0 2 * * 1 (Mondays at 2am)

- Checks for >= 20 new positively-rated conversations
- If threshold met: merges data and submits a new fine-tuning job
- Does NOT auto-deploy -- requires human review first
- Saves job info to data/finetuning_jobs.json

Usage (manual):
    python scripts/weekly_retrain.py [--force] [--min-new N]
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

sys.path.insert(0, str(BASE_DIR))
from dotenv import load_dotenv
load_dotenv()

JOBS_FILE = DATA_DIR / "finetuning_jobs.json"
LOG_FILE = DATA_DIR / "weekly_retrain.log"


def log(msg: str):
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ")
    line = f"[{timestamp}] {msg}"
    print(line)
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")


def count_pending_rated(conn) -> int:
    import psycopg2.extras
    cur = conn.cursor()
    cur.execute("""
        SELECT COUNT(*) AS n FROM ai_conversations
        WHERE rating = 1 AND (exported_for_training = FALSE OR exported_for_training IS NULL)
    """)
    row = cur.fetchone()
    cur.close()
    return row["n"] if row else 0


def run_export(anonymize: bool = True) -> bool:
    """Run export_conversations.py to refresh training_raw.jsonl."""
    import subprocess
    cmd = [sys.executable, str(BASE_DIR / "scripts/export_conversations.py")]
    if anonymize:
        cmd.append("--anonymize")
    result = subprocess.run(cmd, capture_output=True, text=True)
    log(f"Export stdout: {result.stdout.strip()}")
    if result.returncode != 0:
        log(f"Export error: {result.stderr.strip()}")
    return result.returncode == 0


def run_merge() -> bool:
    """Run merge_training_data.py to build training_final.jsonl."""
    import subprocess
    result = subprocess.run(
        [sys.executable, str(BASE_DIR / "scripts/merge_training_data.py")],
        capture_output=True, text=True,
    )
    log(f"Merge stdout: {result.stdout.strip()}")
    if result.returncode != 0:
        log(f"Merge error: {result.stderr.strip()}")
    return result.returncode == 0


def submit_job() -> str | None:
    """Submit fine-tuning job. Returns job_id or None."""
    import openai
    client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

    training_file = DATA_DIR / "training_final.jsonl"
    if not training_file.exists():
        log("ERROR: training_final.jsonl not found")
        return None

    with open(training_file, "rb") as f:
        uploaded = client.files.create(file=f, purpose="fine-tune")

    log(f"File uploaded: {uploaded.id}")

    job = client.fine_tuning.jobs.create(
        training_file=uploaded.id,
        model="gpt-4o-mini-2024-07-18",
        suffix="charlott",
        hyperparameters={"n_epochs": "auto"},
    )

    log(f"Job created: {job.id} (status: {job.status})")

    # Save job info
    jobs = []
    if JOBS_FILE.exists():
        try:
            jobs = json.loads(JOBS_FILE.read_text())
        except Exception:
            pass
    jobs.append({
        "job_id": job.id,
        "submitted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "status": job.status,
        "note": "weekly_retrain auto-submit",
    })
    JOBS_FILE.write_text(json.dumps(jobs, indent=2))

    return job.id


def main():
    parser = argparse.ArgumentParser(description="Weekly auto-retrain pipeline")
    parser.add_argument("--force", action="store_true", help="Skip threshold check and always retrain")
    parser.add_argument("--min-new", type=int, default=20, help="Min new positive conversations (default: 20)")
    args = parser.parse_args()

    log("=== Weekly retrain started ===")

    # Check DB for pending rated conversations
    try:
        import psycopg2
        import psycopg2.extras
        db_url = os.environ.get("DATABASE_URL")
        conn = psycopg2.connect(db_url, cursor_factory=psycopg2.extras.RealDictCursor)
        pending = count_pending_rated(conn)
        conn.close()
        log(f"Pending positively-rated conversations: {pending}")
    except Exception as e:
        log(f"WARNING: Could not check DB ({e}), proceeding anyway")
        pending = 0

    if not args.force and pending < args.min_new:
        log(f"Threshold not met ({pending} < {args.min_new}). Skipping retrain.")
        log("=== Weekly retrain done (no action) ===")
        return 0

    # Export
    log("Running export...")
    if not run_export(anonymize=True):
        log("Export failed, aborting")
        return 1

    # Merge
    log("Running merge...")
    if not run_merge():
        log("Merge failed, aborting")
        return 1

    # Submit
    log("Submitting fine-tuning job...")
    try:
        job_id = submit_job()
        if job_id:
            log(f"SUCCESS: Fine-tuning job {job_id} submitted.")
            log("IMPORTANT: Review the model before deploying:")
            log(f"  python scripts/evaluate_model.py --ft-model <model-id>")
            log(f"  python scripts/run_finetuning.py deploy <model-id>")
        else:
            log("Submit failed")
            return 1
    except Exception as e:
        log(f"Submit error: {e}")
        return 1

    log("=== Weekly retrain done ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
