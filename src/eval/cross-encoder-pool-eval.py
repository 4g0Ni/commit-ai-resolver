"""Evaluate a zero-shot CrossEncoder over the union of cached retrieval channels."""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
from pathlib import Path
from typing import Any

import numpy as np
from sentence_transformers import CrossEncoder


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rerank pooled RCA commit candidates with a local CrossEncoder")
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--raw-report", type=Path, required=True)
    parser.add_argument("--compact-report", type=Path, required=True)
    parser.add_argument("--vectors-db", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", default="cross-encoder/ms-marco-MiniLM-L6-v2")
    parser.add_argument("--device", default="cuda", choices=("cuda", "cpu"))
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--candidate-depth", type=int, default=50)
    return parser.parse_args()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def key(item: dict[str, Any]) -> str:
    return f"{item.get('repo', '')}:{item.get('commitId') or item.get('id', '')}"


def short_key(item: dict[str, Any]) -> str:
    return f"{item.get('repo', '')}:{item.get('id') or str(item.get('commitId', ''))[:8]}"


def load_metadata(path: Path) -> dict[str, dict[str, Any]]:
    db = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    try:
        rows = db.execute("SELECT repo, id, commitId, text, metadata FROM commit_metadata").fetchall()
    finally:
        db.close()
    output = {}
    for repo, short_id, commit_id, text, metadata in rows:
        output[f"{repo}:{short_id}"] = {
            "repo": repo,
            "id": short_id,
            "commitId": commit_id,
            "text": text,
            "metadata": json.loads(metadata),
        }
    return output


def passage(record: dict[str, Any]) -> str:
    metadata = record.get("metadata") or {}
    parts = [
        f"Title: {metadata.get('title', '')}",
        f"Summary: {metadata.get('summary', '')}",
    ]
    areas = metadata.get("affectedAreas") or []
    files = metadata.get("changedFiles") or []
    if areas:
        parts.append(f"Areas: {', '.join(areas[:8])}")
    if files:
        parts.append(f"Files: {', '.join(files[:20])}")
    return "\n".join(parts)


def ranking_metrics(ranked: list[dict[str, Any]], gold: set[str], limit: int) -> dict[str, float]:
    selected = ranked[:limit]
    hits = [index for index, item in enumerate(selected) if key(item) in gold]
    recall = len(hits) / len(gold)
    mrr = 1 / (hits[0] + 1) if hits else 0.0
    dcg = sum(7 / math.log2(index + 2) for index in hits)
    idcg = sum(7 / math.log2(index + 2) for index in range(min(len(gold), limit)))
    return {"recall": recall, "mrr": mrr, "ndcg": dcg / idcg}


def aggregate(case_rows: list[dict[str, Any]], ranking_name: str, split: str | None = None) -> dict[str, float]:
    selected = [row for row in case_rows if split is None or row["split"] == split]
    output = {"cases": len(selected)}
    for limit in (10, 20):
        metrics = [ranking_metrics(row[ranking_name], row["gold"], limit) for row in selected]
        for metric in ("recall", "mrr", "ndcg"):
            output[f"{metric}At{limit}"] = sum(item[metric] for item in metrics) / len(metrics)
    return output


def contribution(rank: int | None, weight: float, k: int) -> float:
    return weight / (k + rank) if rank is not None and weight else 0.0


def blended_ranking(row: dict[str, Any], config: dict[str, Any]) -> list[dict[str, Any]]:
    weights = config["weights"]
    k_value = config["k"]
    return sorted(
        row["pool"],
        key=lambda item: (
            contribution(item["ranks"].get("cross"), weights["cross"], k_value)
            + contribution(item["ranks"].get("rawDense"), weights["rawDense"], k_value)
            + contribution(item["ranks"].get("rawLexical"), weights["rawLexical"], k_value)
            + contribution(item["ranks"].get("compactDense"), weights["compactDense"], k_value)
            + contribution(item["ranks"].get("compactLexical"), weights["compactLexical"], k_value)
        ),
        reverse=True,
    )


def tune_blend(case_rows: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    base_weights = [
        {"rawDense": 1, "rawLexical": 0, "compactDense": 0, "compactLexical": 0},
        {"rawDense": 1, "rawLexical": 0.33, "compactDense": 0, "compactLexical": 0},
        {"rawDense": 1, "rawLexical": 0.2, "compactDense": 0, "compactLexical": 0.2},
        {"rawDense": 1, "rawLexical": 0.2, "compactDense": 0.5, "compactLexical": 0.33},
        {"rawDense": 1, "rawLexical": 0.33, "compactDense": 0.2, "compactLexical": 0},
    ]
    candidates = []
    dev = [row for row in case_rows if row["split"] == "dev"]
    for k_value in (1, 3, 5, 10, 20, 40, 60):
        for cross_weight in (0.1, 0.2, 0.33, 0.5, 0.7, 1, 1.5, 2, 3, 5):
            for base in base_weights:
                config = {"k": k_value, "weights": {"cross": cross_weight, **base}}
                for row in dev:
                    row["candidateBlend"] = blended_ranking(row, config)
                at_20 = aggregate(dev, "candidateBlend")
                objective = at_20["recallAt20"] + 0.15 * at_20["mrrAt10"] + 0.05 * at_20["ndcgAt20"]
                candidates.append({"config": config, "dev": at_20, "objective": objective})
    candidates.sort(key=lambda item: item["objective"], reverse=True)
    return candidates[0]["config"], candidates[:10]


def main() -> None:
    args = parse_args()
    cases = read_jsonl(args.dataset / "cases.jsonl")
    raw = {item["id"]: item for item in read_jsonl(args.raw_report / "case-results.jsonl")}
    compact = {item["id"]: item for item in read_jsonl(args.compact_report / "case-results.jsonl")}
    metadata = load_metadata(args.vectors_db)
    source_spec = (
        ("rawDense", raw, "dense"),
        ("rawLexical", raw, "lexical"),
        ("compactDense", compact, "dense"),
        ("compactLexical", compact, "lexical"),
    )

    case_rows = []
    pairs: list[tuple[str, str]] = []
    pair_items: list[dict[str, Any]] = []
    for eval_case in cases:
        pool: dict[str, dict[str, Any]] = {}
        for source_name, report, channel in source_spec:
            for rank, result in enumerate(report[eval_case["id"]]["channels"][channel]["topResults"][: args.candidate_depth], 1):
                record = metadata.get(short_key(result))
                if not record:
                    raise RuntimeError(f"Missing metadata for {short_key(result)}")
                item = pool.setdefault(key(record), {**record, "ranks": {}})
                item["ranks"][source_name] = rank
        ordered_pool = list(pool.values())
        query = str(eval_case["query"])[:1600]
        for item in ordered_pool:
            pairs.append((query, passage(item)))
            pair_items.append(item)
        case_rows.append({
            "id": eval_case["id"],
            "split": eval_case["split"],
            "gold": {key(item) for item in eval_case["relevantCommits"]},
            "pool": ordered_pool,
        })

    model = CrossEncoder(args.model, device=args.device, max_length=512)
    scores = model.predict(pairs, batch_size=args.batch_size, show_progress_bar=True)
    for item, score in zip(pair_items, np.asarray(scores).reshape(-1), strict=True):
        item["crossScore"] = float(score)
    for row in case_rows:
        row["crossEncoder"] = sorted(row["pool"], key=lambda item: item["crossScore"], reverse=True)
        for rank, item in enumerate(row["crossEncoder"], 1):
            item["ranks"]["cross"] = rank

    best_config, dev_search = tune_blend(case_rows)
    for row in case_rows:
        row["candidateBlend"] = blended_ranking(row, best_config)

    summary = {
        "schemaVersion": 1,
        "evaluationPolicy": "model-prescreened, non-gold, release-gate-ineligible",
        "model": args.model,
        "device": args.device,
        "candidateDepthPerSource": args.candidate_depth,
        "pairs": len(pairs),
        "averagePoolSize": sum(len(row["pool"]) for row in case_rows) / len(case_rows),
        "bestConfigSelectedOnDev": best_config,
        "devSearchTop10": dev_search,
        "metrics": {
            ranking: {
                "all": aggregate(case_rows, ranking),
                "dev": aggregate(case_rows, ranking, "dev"),
                "test": aggregate(case_rows, ranking, "test"),
            }
            for ranking in ("crossEncoder", "candidateBlend")
        },
    }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary["metrics"], indent=2))


if __name__ == "__main__":
    main()
