"""Measure title-field vector retrieval as a candidate-pool supplement.

This diagnostic keeps the frozen raw/compact retrieval caches unchanged. It
embeds only commit titles and issue titles, then reports whether the new field
channel adds relevant commits to the existing candidate pool. Model selection
must use the dev split; the pilot remains non-gold and release-gate-ineligible.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sqlite3
from pathlib import Path
from typing import Any

import torch
from sentence_transformers import SentenceTransformer


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODEL_PATH = PROJECT_ROOT / "data" / "models" / "Qwen3-Embedding-0.6B"
QUERY_INSTRUCTION = (
    "Instruct: Retrieve source-code commits that may explain the reported software symptom, "
    "regression, configuration change, or production incident.\nQuery: "
)
BRACKET_PREFIX = re.compile(r"^(?:\[[^\]]+\]\s*)+")
PR_SUFFIX = re.compile(r"\s*\(#\d+\)\s*$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--raw-report", type=Path, required=True)
    parser.add_argument("--compact-report", type=Path, required=True)
    parser.add_argument("--vectors-db", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--candidate-depth", type=int, default=100)
    parser.add_argument("--maximum-field-depth", type=int, default=200)
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    parser.add_argument(
        "--model-path",
        type=Path,
        default=Path(os.environ.get("LOCAL_EMBEDDING_MODEL_PATH", DEFAULT_MODEL_PATH)),
    )
    return parser.parse_args()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def result_identity(item: dict[str, Any]) -> str:
    return f"{item.get('repo', '')}:{item.get('commitId') or item.get('id', '')}"


def clean_title(value: str) -> str:
    title = str(value or "").splitlines()[0].strip()
    title = BRACKET_PREFIX.sub("", title)
    return PR_SUFFIX.sub("", title).strip() or str(value or "").splitlines()[0].strip()


def load_commits(path: Path) -> list[dict[str, str]]:
    db = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    try:
        rows = db.execute(
            "SELECT repo, id, commitId, date, author, metadata FROM commit_metadata ORDER BY rowid"
        ).fetchall()
    finally:
        db.close()
    commits = []
    for repo, short_id, commit_id, date, author, metadata_json in rows:
        metadata = json.loads(metadata_json)
        commits.append({
            "repo": repo,
            "id": short_id,
            "commitId": commit_id,
            "date": date,
            "author": author or "",
            "riskLevel": str(metadata.get("riskLevel") or ""),
            "changeType": str(metadata.get("changeType") or ""),
            "title": str(metadata.get("title") or ""),
        })
    return commits


def matches_filters(commit: dict[str, str], filters: dict[str, Any]) -> bool:
    if filters.get("repo") and commit["repo"] != filters["repo"]:
        return False
    if filters.get("author") and filters["author"].lower() not in commit["author"].lower():
        return False
    if filters.get("dateFrom") and commit["date"] < filters["dateFrom"]:
        return False
    if filters.get("dateTo") and commit["date"] > filters["dateTo"]:
        return False
    if filters.get("riskLevel") and commit["riskLevel"] != filters["riskLevel"]:
        return False
    change_type = filters.get("changeType")
    if change_type == "config" and commit["changeType"] not in ("config", "mixed"):
        return False
    if change_type and change_type != "config" and commit["changeType"] != change_type:
        return False
    return True


def encode(model: SentenceTransformer, texts: list[str], *, device: str, batch_size: int) -> torch.Tensor:
    return model.encode(
        texts,
        batch_size=batch_size,
        convert_to_tensor=True,
        normalize_embeddings=True,
        show_progress_bar=True,
        device=device,
    )


def field_rankings(
    model: SentenceTransformer,
    cases: list[dict[str, Any]],
    commits: list[dict[str, str]],
    *,
    device: str,
    maximum_depth: int,
) -> dict[str, dict[str, list[dict[str, Any]]]]:
    document_texts = [commit["title"] or commit["id"] for commit in commits]
    document_vectors = encode(model, document_texts, device=device, batch_size=64)
    query_titles = [str(case.get("query") or "").splitlines()[0].strip() for case in cases]
    query_views = {
        "titleRaw": query_titles,
        "titleClean": [clean_title(title) for title in query_titles],
    }
    rankings = {case["id"]: {} for case in cases}
    for channel, queries in query_views.items():
        query_vectors = encode(
            model,
            [f"{QUERY_INSTRUCTION}{query}" for query in queries],
            device=device,
            batch_size=64,
        )
        for case_index, case in enumerate(cases):
            allowed = [index for index, commit in enumerate(commits) if matches_filters(commit, case.get("filters") or {})]
            allowed_tensor = torch.tensor(allowed, device=document_vectors.device, dtype=torch.long)
            scores = torch.mv(document_vectors.index_select(0, allowed_tensor), query_vectors[case_index])
            depth = min(maximum_depth, scores.numel())
            values, local_indices = torch.topk(scores, k=depth)
            rows = []
            for rank, (score, local_index) in enumerate(zip(values.tolist(), local_indices.tolist(), strict=True), 1):
                commit = commits[allowed[local_index]]
                rows.append({
                    "rank": rank,
                    "repo": commit["repo"],
                    "id": commit["id"],
                    "commitId": commit["commitId"],
                    "score": score,
                })
            rankings[case["id"]][channel] = rows
        del query_vectors
    return rankings


def pool_for_case(
    case: dict[str, Any],
    raw: dict[str, Any],
    compact: dict[str, Any],
    field: dict[str, list[dict[str, Any]]],
    *,
    candidate_depth: int,
    field_depth: int,
    field_channels: tuple[str, ...],
) -> dict[str, dict[str, Any]]:
    pool: dict[str, dict[str, Any]] = {}
    sources = (
        ("rawDense", raw[case["id"]]["channels"]["dense"]["topResults"][:candidate_depth]),
        ("rawLexical", raw[case["id"]]["channels"]["lexical"]["topResults"][:candidate_depth]),
        ("compactDense", compact[case["id"]]["channels"]["dense"]["topResults"][:candidate_depth]),
        ("compactLexical", compact[case["id"]]["channels"]["lexical"]["topResults"][:candidate_depth]),
        *((channel, field[channel][:field_depth]) for channel in field_channels),
    )
    for channel, results in sources:
        for result in results:
            key = result_identity(result)
            item = pool.setdefault(key, {"repo": result["repo"], "id": result["id"], "commitId": result["commitId"], "channels": []})
            item["channels"].append(channel)
    return pool


def availability(rows: list[dict[str, Any]], split: str) -> dict[str, Any]:
    selected = [row for row in rows if row["split"] == split]
    recalls = [len(row["gold"] & row["pool"]) / len(row["gold"]) for row in selected]
    sizes = sorted(len(row["pool"]) for row in selected)
    return {
        "cases": len(selected),
        "recall": sum(recalls) / len(recalls),
        "hitRate": sum(value > 0 for value in recalls) / len(recalls),
        "missedCases": sum(value == 0 for value in recalls),
        "averagePoolSize": sum(sizes) / len(sizes),
        "p95PoolSize": sizes[min(len(sizes) - 1, math.floor(len(sizes) * 0.95))],
    }


def main() -> None:
    args = parse_args()
    if args.candidate_depth <= 0 or args.maximum_field_depth <= 0:
        raise RuntimeError("candidate depths must be positive")
    cases = read_jsonl(args.dataset / "cases.jsonl")
    raw = {item["id"]: item for item in read_jsonl(args.raw_report / "case-results.jsonl")}
    compact = {item["id"]: item for item in read_jsonl(args.compact_report / "case-results.jsonl")}
    commits = load_commits(args.vectors_db)
    model_kwargs = {"dtype": torch.float16} if args.device == "cuda" else {}
    model = SentenceTransformer(str(args.model_path), device=args.device, model_kwargs=model_kwargs)
    fields = field_rankings(
        model,
        cases,
        commits,
        device=args.device,
        maximum_depth=args.maximum_field_depth,
    )

    depths = sorted({value for value in (0, 10, 25, 50, 100, args.maximum_field_depth) if value <= args.maximum_field_depth})
    configurations = {}
    details = []
    for field_depth in depths:
        channels = ("titleRaw", "titleClean") if field_depth else ()
        rows = []
        for case in cases:
            pool = pool_for_case(
                case,
                raw,
                compact,
                fields[case["id"]],
                candidate_depth=args.candidate_depth,
                field_depth=field_depth,
                field_channels=channels,
            )
            rows.append({
                "id": case["id"],
                "split": case["split"],
                "gold": {result_identity(item) for item in case["relevantCommits"]},
                "pool": set(pool),
            })
            if field_depth == args.maximum_field_depth:
                details.append({
                    "id": case["id"],
                    "split": case["split"],
                    "gold": sorted(rows[-1]["gold"]),
                    "poolSize": len(pool),
                    "goldChannels": {
                        key: pool[key]["channels"] for key in rows[-1]["gold"] if key in pool
                    },
                    "titleRaw": fields[case["id"]]["titleRaw"],
                    "titleClean": fields[case["id"]]["titleClean"],
                })
        configurations[str(field_depth)] = {
            "fieldDepthPerChannel": field_depth,
            "dev": availability(rows, "dev"),
            "test": availability(rows, "test"),
        }

    summary = {
        "schemaVersion": 1,
        "evaluationPolicy": "model-prescreened, non-gold, release-gate-ineligible",
        "model": "Qwen/Qwen3-Embedding-0.6B",
        "documentField": "title",
        "queryViews": ["raw issue title", "title with bracket prefix and PR suffix removed"],
        "basePool": {
            "channels": ["rawDense", "rawLexical", "compactDense", "compactLexical"],
            "depthPerChannel": args.candidate_depth,
        },
        "configurations": configurations,
        "selectionPolicy": "Choose field depth on dev only; read test once after freezing the choice.",
    }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    (args.output / "case-results.jsonl").write_text(
        "\n".join(json.dumps(item) for item in details) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"configurations": configurations}, indent=2))


if __name__ == "__main__":
    main()
