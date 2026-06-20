#!/usr/bin/env python3
"""
CLI for managing OpenAI fine-tuning jobs.

Usage:
    python scripts/run_finetuning.py submit
    python scripts/run_finetuning.py status <job_id>
    python scripts/run_finetuning.py list
    python scripts/run_finetuning.py deploy <ft:gpt-4o-mini-...>
    python scripts/run_finetuning.py rollback
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

HISTORY_FILE = DATA_DIR / "model_history.json"
JOBS_FILE = DATA_DIR / "finetuning_jobs.json"
TRAINING_FILE = DATA_DIR / "training_final.jsonl"

sys.path.insert(0, str(BASE_DIR))
from dotenv import load_dotenv
load_dotenv()

try:
    import openai
    client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
except ImportError:
    print("ERROR: openai package not installed. Run: pip install openai")
    sys.exit(1)


# ── DB helpers ────────────────────────────────────────────────────────────────

def get_db_conn():
    import psycopg2
    import psycopg2.extras
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL not set")
    return psycopg2.connect(url, cursor_factory=psycopg2.extras.RealDictCursor)


def get_current_model() -> dict:
    try:
        conn = get_db_conn()
        cur = conn.cursor()
        cur.execute("SELECT id, model, base_model FROM ai_agents LIMIT 1")
        row = cur.fetchone()
        cur.close()
        conn.close()
        if row:
            return {"id": row["id"], "model": row["model"], "base_model": row.get("base_model", "gpt-4o-mini")}
    except Exception as e:
        print(f"[warn] Could not read model from DB: {e}")
    return {"id": 1, "model": "gpt-4o-mini", "base_model": "gpt-4o-mini"}


def set_model_in_db(agent_id: int, model: str):
    conn = get_db_conn()
    cur = conn.cursor()
    cur.execute("UPDATE ai_agents SET model = %s WHERE id = %s", (model, agent_id))
    conn.commit()
    cur.close()
    conn.close()


# ── History tracking ──────────────────────────────────────────────────────────

def load_history() -> list:
    if HISTORY_FILE.exists():
        return json.loads(HISTORY_FILE.read_text())
    return []


def save_history(history: list):
    HISTORY_FILE.write_text(json.dumps(history, indent=2))


def push_history(model: str):
    history = load_history()
    history.append({"model": model, "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ")})
    save_history(history)


def load_jobs() -> list:
    if JOBS_FILE.exists():
        return json.loads(JOBS_FILE.read_text())
    return []


def save_jobs(jobs: list):
    JOBS_FILE.write_text(json.dumps(jobs, indent=2))


def add_job(job_id: str, model_suffix: str):
    jobs = load_jobs()
    jobs.append({
        "job_id": job_id,
        "model_suffix": model_suffix,
        "submitted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "status": "queued",
    })
    save_jobs(jobs)


# ── Commands ──────────────────────────────────────────────────────────────────

def cmd_submit(args):
    if not TRAINING_FILE.exists():
        print(f"ERROR: {TRAINING_FILE} not found. Run merge_training_data.py first.")
        sys.exit(1)

    file_size = TRAINING_FILE.stat().st_size
    line_count = sum(1 for _ in TRAINING_FILE.open())
    print(f"[submit] Uploading {TRAINING_FILE.name} ({file_size:,} bytes, {line_count} examples)...")

    with open(TRAINING_FILE, "rb") as f:
        uploaded = client.files.create(file=f, purpose="fine-tune")

    print(f"[submit] File uploaded: {uploaded.id}")
    print(f"[submit] Creating fine-tuning job (suffix: charlott)...")

    job = client.fine_tuning.jobs.create(
        training_file=uploaded.id,
        model="gpt-4o-mini-2024-07-18",
        suffix="charlott",
        hyperparameters={
            "n_epochs": "auto",
        },
    )

    print(f"\n[submit] Job created!")
    print(f"  Job ID:  {job.id}")
    print(f"  Status:  {job.status}")
    print(f"\nMonitor with:")
    print(f"  python scripts/run_finetuning.py status {job.id}")

    add_job(job.id, "charlott")
    return job.id


def cmd_status(args):
    job_id = args.job_id

    # If no job_id given, use last known job
    if not job_id:
        jobs = load_jobs()
        if not jobs:
            print("No jobs found. Submit first.")
            sys.exit(1)
        job_id = jobs[-1]["job_id"]
        print(f"[status] Using last job: {job_id}")

    job = client.fine_tuning.jobs.retrieve(job_id)

    print(f"\n[status] Fine-tuning job: {job_id}")
    print(f"  Status:         {job.status}")
    print(f"  Model:          {job.model}")
    print(f"  Created at:     {job.created_at}")
    if job.finished_at:
        print(f"  Finished at:    {job.finished_at}")
    if job.fine_tuned_model:
        print(f"  FT Model:       {job.fine_tuned_model}")
        print(f"\nDeploy with:")
        print(f"  python scripts/run_finetuning.py deploy {job.fine_tuned_model}")
    if job.trained_tokens:
        print(f"  Trained tokens: {job.trained_tokens:,}")
    if job.error:
        print(f"  Error:          {job.error}")

    # Show recent events
    events = client.fine_tuning.jobs.list_events(job_id, limit=5)
    if events.data:
        print(f"\n  Recent events:")
        for ev in reversed(events.data):
            print(f"    [{ev.created_at}] {ev.message}")

    return job.status


def cmd_list(args):
    jobs = client.fine_tuning.jobs.list(limit=10)
    print(f"\n[list] Recent fine-tuning jobs:")
    for job in jobs.data:
        ft_model = job.fine_tuned_model or "(pending)"
        print(f"  {job.id}  {job.status:12s}  {ft_model}")


def cmd_deploy(args):
    ft_model = args.model
    if not ft_model.startswith("ft:"):
        print(f"ERROR: Model must start with 'ft:'. Got: {ft_model}")
        sys.exit(1)

    current = get_current_model()
    current_model = current["model"]
    agent_id = current["id"]

    print(f"[deploy] Current model: {current_model}")
    print(f"[deploy] New model:     {ft_model}")
    print(f"[deploy] Agent ID:      {agent_id}")

    confirm = input("Deploy? [y/N] ").strip().lower()
    if confirm != "y":
        print("Aborted.")
        sys.exit(0)

    # Save current model to history (for rollback)
    push_history(current_model)
    print(f"[deploy] Saved {current_model} to rollback history")

    # Update DB
    set_model_in_db(agent_id, ft_model)
    print(f"[deploy] Updated ai_agents.model = {ft_model}")
    print(f"[deploy] Done! Bot is now using the fine-tuned model.")
    print(f"\nRollback with:")
    print(f"  python scripts/run_finetuning.py rollback")


def cmd_rollback(args):
    history = load_history()
    if not history:
        print("No rollback history found.")
        sys.exit(1)

    last = history[-1]
    rollback_model = last["model"]
    timestamp = last.get("timestamp", "unknown")

    current = get_current_model()
    agent_id = current["id"]

    print(f"[rollback] Current model:  {current['model']}")
    print(f"[rollback] Rollback to:    {rollback_model} (deployed at {timestamp})")

    confirm = input("Rollback? [y/N] ").strip().lower()
    if confirm != "y":
        print("Aborted.")
        sys.exit(0)

    set_model_in_db(agent_id, rollback_model)
    history.pop()
    save_history(history)
    print(f"[rollback] Done! Bot is now using {rollback_model}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Fine-tuning CLI for Charlott")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("submit", help="Upload training data and create fine-tuning job")

    p_status = sub.add_parser("status", help="Check job status")
    p_status.add_argument("job_id", nargs="?", default=None, help="Job ID (default: last job)")

    sub.add_parser("list", help="List recent fine-tuning jobs")

    p_deploy = sub.add_parser("deploy", help="Deploy a fine-tuned model to production")
    p_deploy.add_argument("model", help="Fine-tuned model ID (ft:gpt-4o-mini-...)")

    sub.add_parser("rollback", help="Revert to previous model")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    commands = {
        "submit": cmd_submit,
        "status": cmd_status,
        "list": cmd_list,
        "deploy": cmd_deploy,
        "rollback": cmd_rollback,
    }

    commands[args.command](args)


if __name__ == "__main__":
    main()
