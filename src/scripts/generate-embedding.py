"""Build the commit RAG index with a local CUDA embedding model.

The daily JSON files remain the source of truth. This script embeds their
searchable commit text with Qwen3-Embedding-0.6B and upserts the result into
the SQLite metadata, FTS5, and sqlite-vec tables consumed by the Node API.

Run from the project root:
    conda run -n hello-agents python src/scripts/generate-embedding.py
    conda run -n hello-agents python src/scripts/generate-embedding.py --force
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import torch
from sentence_transformers import SentenceTransformer


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_ROOT = Path(os.environ.get("DATA_DIR", PROJECT_ROOT / "data"))
DAILY_DIR = DATA_ROOT / "daily"
VECTORS_DB = Path(os.environ.get("VECTORS_DB", DATA_ROOT / "vectors.db"))
MODEL_ID = os.environ.get("LOCAL_EMBEDDING_MODEL_ID", "Qwen/Qwen3-Embedding-0.6B")
MODEL_DIR = Path(
    os.environ.get(
        "LOCAL_EMBEDDING_MODEL_PATH",
        DATA_ROOT / "models" / "Qwen3-Embedding-0.6B",
    )
)
MODEL_CONTRACT = MODEL_ID
EMBEDDING_DIMENSIONS = 1024
DOCUMENT_TEMPLATE_VERSION = "2"

SHARED_INFRA_PATTERNS = [
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"/grid-shared/",
        r"/shared-client-react/",
        r"/app-layout-container/",
        r"/shared-components?/",
        r"/packages/[^/]*shared[^/]*/",
        r"/packages/[^/]*common[^/]*/",
        r"/src/(shared|common|contexts?|hooks|utils)/",
        r"[-/](filter-action-bar|filter-bar|action-bar)\.[jt]sx?$",
        r"[-/][a-z0-9]+-context\.[jt]sx?$",
        r"[-/]layout-configs?\.[jt]sx?$",
    )
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate local CUDA embeddings for the commit RAG index."
    )
    parser.add_argument("--days", type=int, help="Only process the newest N daily files")
    parser.add_argument("--from", dest="date_from", help="Start date YYYY-MM-DD")
    parser.add_argument("--to", dest="date_to", help="End date YYYY-MM-DD")
    parser.add_argument(
        "--force", action="store_true", help="Re-embed matching commits already in the index"
    )
    parser.add_argument(
        "--rebuild",
        action="store_true",
        help="Delete and recreate the derived vector index before embedding",
    )
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--device", default="cuda", choices=("cuda", "cpu", "auto"))
    return parser.parse_args()


def ensure_model() -> Path:
    if (MODEL_DIR / "model.safetensors").is_file():
        return MODEL_DIR

    print(f"Local model not found; downloading {MODEL_ID} to {MODEL_DIR} ...")
    try:
        from modelscope import snapshot_download
    except ImportError as error:
        raise RuntimeError(
            "ModelScope is required for first-time download. Install requirements-embedding.txt."
        ) from error

    MODEL_DIR.parent.mkdir(parents=True, exist_ok=True)
    downloaded = Path(snapshot_download(MODEL_ID, local_dir=str(MODEL_DIR)))
    if not (downloaded / "model.safetensors").is_file():
        raise RuntimeError(f"Model download is incomplete: {downloaded}")
    return downloaded


def select_device(requested: str) -> str:
    if requested == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if requested == "cuda" and not torch.cuda.is_available():
        raise RuntimeError(
            "CUDA was requested but PyTorch cannot see a GPU. Install a CUDA-enabled "
            "PyTorch build or pass --device cpu explicitly."
        )
    return requested


def sqlite_vec_extension() -> Path:
    candidates = (
        PROJECT_ROOT / "src" / "node_modules" / "sqlite-vec-windows-x64" / "vec0.dll",
        PROJECT_ROOT / "src" / "node_modules" / "sqlite-vec-linux-x64" / "vec0.so",
        PROJECT_ROOT / "src" / "node_modules" / "sqlite-vec-darwin-x64" / "vec0.dylib",
        PROJECT_ROOT / "src" / "node_modules" / "sqlite-vec-darwin-arm64" / "vec0.dylib",
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise RuntimeError("sqlite-vec extension not found. Run npm install in src first.")


def connect_db(rebuild: bool) -> sqlite3.Connection:
    VECTORS_DB.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(VECTORS_DB)
    db.enable_load_extension(True)
    db.load_extension(str(sqlite_vec_extension()))
    db.execute("PRAGMA journal_mode=WAL")

    if rebuild:
        db.executescript(
            """
            DROP TABLE IF EXISTS commit_vectors;
            DROP TABLE IF EXISTS commit_metadata;
            DROP TABLE IF EXISTS commit_fts;
            DROP TABLE IF EXISTS vector_store_meta;
            """
        )

    db.executescript(
        f"""
        CREATE TABLE IF NOT EXISTS commit_metadata (
            rowid INTEGER PRIMARY KEY,
            id TEXT NOT NULL,
            commitId TEXT,
            repo TEXT NOT NULL,
            date TEXT NOT NULL,
            author TEXT,
            text TEXT,
            metadata TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_repo_id ON commit_metadata(repo, id);
        CREATE INDEX IF NOT EXISTS idx_meta_date ON commit_metadata(date);
        CREATE INDEX IF NOT EXISTS idx_meta_repo_date ON commit_metadata(repo, date);
        CREATE VIRTUAL TABLE IF NOT EXISTS commit_vectors USING vec0(
            embedding float[{EMBEDDING_DIMENSIONS}] distance_metric=cosine,
            repo text partition key
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS commit_fts USING fts5(
            text, tokenize='unicode61'
        );
        CREATE TABLE IF NOT EXISTS vector_store_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
    )
    ensure_contract(db)
    return db


def ensure_contract(db: sqlite3.Connection) -> None:
    expected = {
        "embeddingModel": MODEL_CONTRACT,
        "embeddingDimensions": str(EMBEDDING_DIMENSIONS),
        "documentTemplateVersion": DOCUMENT_TEMPLATE_VERSION,
    }
    total = db.execute("SELECT COUNT(*) FROM commit_metadata").fetchone()[0]
    current = dict(db.execute("SELECT key, value FROM vector_store_meta"))
    mismatches = {
        key: (current.get(key), value)
        for key, value in expected.items()
        if current.get(key) not in (None, value)
    }
    if mismatches and total:
        details = ", ".join(
            f"{key}: database={old}, configured={new}"
            for key, (old, new) in mismatches.items()
        )
        raise RuntimeError(f"Vector index contract mismatch ({details}). Re-run with --rebuild.")

    # An empty DB is safe to repair, including a stale vec0 dimension declaration.
    if mismatches:
        db.execute("DROP TABLE commit_vectors")
        db.execute(
            f"""CREATE VIRTUAL TABLE commit_vectors USING vec0(
                embedding float[{EMBEDDING_DIMENSIONS}] distance_metric=cosine,
                repo text partition key
            )"""
        )
    for key, value in expected.items():
        db.execute(
            """INSERT INTO vector_store_meta(key, value) VALUES (?, ?)
               ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
            (key, value),
        )
    db.commit()


def clean_commit_subject(message: str, max_length: int = 200) -> str:
    first_line = (message or "").split("\n", 1)[0]
    subject = re.sub(r"^Merged PR \d+:\s*", "", first_line, flags=re.IGNORECASE).strip()
    return subject if len(subject) <= max_length else f"{subject[:max_length].strip()}…"


def is_shared_path(path: str) -> bool:
    normalized = f"/{path.lstrip('/')}"
    return any(pattern.search(normalized) for pattern in SHARED_INFRA_PATTERNS)


def compact_path(path: str) -> str:
    parts = [part for part in path.lstrip("/").split("/") if part]
    if not parts:
        return ""
    if "packages" in parts:
        package_index = len(parts) - 1 - parts[::-1].index("packages")
        if package_index + 1 < len(parts):
            return f"{parts[package_index + 1]}/{parts[-1]}"
    return "/".join(parts[-2:])


def compact_paths(paths: list[str], maximum: int = 15) -> list[str]:
    ordered_paths = [path for path in paths if is_shared_path(path)] + [
        path for path in paths if not is_shared_path(path)
    ]
    tokens: list[str] = []
    for path in ordered_paths:
        token = compact_path(path)
        if token and token not in tokens:
            tokens.append(token)
    if len(tokens) <= maximum:
        return tokens
    return [*tokens[:maximum], f"+{len(tokens) - maximum} more files"]


def build_commit_text(commit: dict[str, Any], repo: str) -> str:
    summary = commit.get("summary") or commit.get("llmSummary") or {}
    title = summary.get("title") or commit.get("title") or commit.get("message") or "Untitled"
    description = summary.get("summary") or title
    parts = [f"Repository: {repo}", f"Title: {title}", f"Summary: {description}"]
    if summary.get("affectedAreas"):
        parts.append(f"Areas: {', '.join(summary['affectedAreas'])}")
    if summary.get("flags"):
        parts.append(f"Flags: {', '.join(summary['flags'])}")
    if summary.get("changeType") and summary["changeType"] != "code":
        parts.append(f"Type: {summary['changeType']}")
    if summary.get("configChanges"):
        changes = []
        for change in summary["configChanges"]:
            detail = f"{change.get('action', '')} {change.get('key', '')}: {change.get('detail', '')}".strip()
            if change.get("from") or change.get("to"):
                detail += f" ({change.get('from') or '?'} -> {change.get('to') or '?'})"
            changes.append(detail)
        parts.append(f"Config: {'; '.join(changes)}")
    subject = clean_commit_subject(commit.get("message", ""))
    if subject and subject != title:
        parts.append(f"Commit message: {subject}")
    path_tokens = compact_paths(commit.get("changedFiles") or [])
    if path_tokens:
        parts.append(f"Files: {', '.join(path_tokens)}")
    return "\n".join(parts)


def selected_daily_files(args: argparse.Namespace) -> list[Path]:
    if not DAILY_DIR.is_dir():
        raise RuntimeError(f"Daily data directory not found: {DAILY_DIR}")
    files = sorted(
        (path for path in DAILY_DIR.glob("????-??-??.json") if path.is_file()),
        reverse=True,
    )
    if args.date_from:
        files = [path for path in files if path.stem >= args.date_from]
    if args.date_to:
        files = [path for path in files if path.stem <= args.date_to]
    if args.days is not None:
        if args.days <= 0:
            raise RuntimeError("--days must be a positive integer")
        files = files[: args.days]
    return files


def collect_commits(
    files: list[Path], existing: set[tuple[str, str]], force: bool
) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for path in files:
        payload = json.loads(path.read_text(encoding="utf-8"))
        for repo, repo_data in (payload.get("repositories") or {}).items():
            for commit in repo_data.get("commits") or []:
                commit_id = str(commit.get("commitId") or "")
                short_id = str(commit.get("shortId") or commit_id[:8])
                if not short_id or (not force and (repo, short_id) in existing):
                    continue
                summary = commit.get("summary") or commit.get("llmSummary") or {}
                entries.append(
                    {
                        "id": short_id,
                        "commitId": commit_id,
                        "repo": repo,
                        "date": path.stem,
                        "author": commit.get("author") or "",
                        "text": build_commit_text(commit, repo),
                        "metadata": {
                            "author": commit.get("author") or "",
                            "title": summary.get("title") or commit.get("title") or "",
                            "summary": summary.get("summary") or "",
                            "riskLevel": summary.get("riskLevel") or "LOW",
                            "changeType": summary.get("changeType") or "code",
                            "affectedAreas": summary.get("affectedAreas") or [],
                            "flags": summary.get("flags") or [],
                            "changedFiles": commit.get("changedFiles") or [],
                            "url": commit.get("url") or "",
                        },
                    }
                )
    return entries


def upsert_batch(
    db: sqlite3.Connection, entries: list[dict[str, Any]], embeddings: np.ndarray
) -> None:
    for entry, embedding in zip(entries, embeddings, strict=True):
        existing = db.execute(
            "SELECT rowid FROM commit_metadata WHERE repo=? AND id=?",
            (entry["repo"], entry["id"]),
        ).fetchone()
        metadata = json.dumps(entry["metadata"], ensure_ascii=False, separators=(",", ":"))
        if existing:
            rowid = existing[0]
            db.execute(
                """UPDATE commit_metadata
                   SET commitId=?, date=?, author=?, text=?, metadata=? WHERE rowid=?""",
                (
                    entry["commitId"], entry["date"], entry["author"],
                    entry["text"], metadata, rowid,
                ),
            )
            db.execute("DELETE FROM commit_vectors WHERE rowid=?", (rowid,))
            db.execute("DELETE FROM commit_fts WHERE rowid=?", (rowid,))
        else:
            cursor = db.execute(
                """INSERT INTO commit_metadata(id, commitId, repo, date, author, text, metadata)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    entry["id"], entry["commitId"], entry["repo"], entry["date"],
                    entry["author"], entry["text"], metadata,
                ),
            )
            rowid = cursor.lastrowid
        vector = np.asarray(embedding, dtype=np.float32)
        if vector.shape != (EMBEDDING_DIMENSIONS,):
            raise RuntimeError(f"Unexpected embedding shape: {vector.shape}")
        db.execute(
            "INSERT INTO commit_vectors(rowid, embedding, repo) VALUES (?, ?, ?)",
            (rowid, vector.tobytes(), entry["repo"]),
        )
        db.execute("INSERT INTO commit_fts(rowid, text) VALUES (?, ?)", (rowid, entry["text"]))
    db.commit()


def print_stats(db: sqlite3.Connection, device: str, model_path: Path) -> None:
    total = db.execute("SELECT COUNT(*) FROM commit_metadata").fetchone()[0]
    repos = [row[0] for row in db.execute("SELECT DISTINCT repo FROM commit_metadata ORDER BY repo")]
    date_from, date_to = db.execute("SELECT MIN(date), MAX(date) FROM commit_metadata").fetchone()
    print("\nVector store stats:")
    print(f"  Total commits: {total}")
    print(f"  Repos: {', '.join(repos)}")
    print(f"  Date range: {date_from} -> {date_to}")
    print(f"  Model: {MODEL_CONTRACT} ({EMBEDDING_DIMENSIONS} dimensions)")
    print(f"  Model path: {model_path}")
    print(f"  Device: {device}")


def main() -> None:
    args = parse_args()
    if args.batch_size <= 0:
        raise RuntimeError("--batch-size must be a positive integer")
    device = select_device(args.device)
    model_path = ensure_model()
    files = selected_daily_files(args)
    print(f"Processing {len(files)} daily files from {DAILY_DIR}")
    print(
        f"PyTorch {torch.__version__}; device={device}; "
        f"GPU={torch.cuda.get_device_name(0) if device == 'cuda' else 'disabled'}"
    )

    db = connect_db(args.rebuild)
    try:
        existing = set(db.execute("SELECT repo, id FROM commit_metadata"))
        entries = collect_commits(files, existing, args.force)
        print(f"Existing vector store: {len(existing)} commits")
        if not entries:
            print("All matching commits are already embedded. Use --force to re-embed.")
            print_stats(db, device, model_path)
            return

        print(f"Loading local model from {model_path}")
        model_kwargs = {"dtype": torch.float16} if device == "cuda" else {}
        model = SentenceTransformer(
            str(model_path), device=device, model_kwargs=model_kwargs
        )
        if model.get_embedding_dimension() != EMBEDDING_DIMENSIONS:
            raise RuntimeError(
                f"Model outputs {model.get_embedding_dimension()} dimensions; "
                f"expected {EMBEDDING_DIMENSIONS}."
            )

        print(f"Generating embeddings for {len(entries)} commits ...")
        for offset in range(0, len(entries), args.batch_size):
            batch = entries[offset : offset + args.batch_size]
            embeddings = model.encode(
                [entry["text"] for entry in batch],
                batch_size=args.batch_size,
                convert_to_numpy=True,
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            upsert_batch(db, batch, embeddings)
            completed = min(offset + len(batch), len(entries))
            if completed == len(entries) or completed % (args.batch_size * 10) == 0:
                print(f"  [{completed}/{len(entries)}] embedded")

        updated = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        db.execute(
            """INSERT INTO vector_store_meta(key, value) VALUES ('lastUpdated', ?)
               ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
            (updated,),
        )
        db.commit()
        print_stats(db, device, model_path)
        print("Done!")
    finally:
        db.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Fatal error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
