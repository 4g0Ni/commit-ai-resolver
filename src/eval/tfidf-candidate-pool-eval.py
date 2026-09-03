"""Evaluate a frozen character TF-IDF candidate-generation supplement.

The vectorizer is fit on the fixed commit corpus plus dev queries only. Test
queries are transform-only. The selected channel retrieves commit documents
with the first line (issue title) using character 3-5 grams, then unions those
candidates with the existing raw/compact Dense/Lexical pool.
"""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--raw-report", type=Path, required=True)
    parser.add_argument("--compact-report", type=Path, required=True)
    parser.add_argument("--vectors-db", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--candidate-depth", type=int, default=100)
    parser.add_argument("--supplemental-depth", type=int, default=100)
    return parser.parse_args()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def identity(item: dict[str, Any]) -> str:
    return f"{item.get('repo', '')}:{item.get('commitId') or item.get('id', '')}"


def load_commits(path: Path) -> list[dict[str, Any]]:
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
            "summary": str(metadata.get("summary") or ""),
            "areas": metadata.get("affectedAreas") or [],
            "files": metadata.get("changedFiles") or [],
        })
    return commits


def document_text(commit: dict[str, Any]) -> str:
    return "\n".join(filter(None, (
        commit["title"],
        commit["summary"],
        " ".join(commit["areas"]),
        " ".join(commit["files"]),
    )))


def matches_filters(commit: dict[str, Any], filters: dict[str, Any]) -> bool:
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


def retrieve(
    cases: list[dict[str, Any]],
    commits: list[dict[str, Any]],
    vectorizer: TfidfVectorizer,
    document_matrix: Any,
    depth: int,
) -> dict[str, list[dict[str, Any]]]:
    titles = [str(case.get("query") or "").splitlines()[0].strip() for case in cases]
    query_matrix = vectorizer.transform(titles)
    output = {}
    for case_index, case in enumerate(cases):
        allowed = np.asarray(
            [index for index, commit in enumerate(commits) if matches_filters(commit, case.get("filters") or {})],
            dtype=np.int32,
        )
        scores = (query_matrix[case_index] @ document_matrix[allowed].T).toarray().ravel()
        selected_depth = min(depth, len(scores))
        local_indices = np.argpartition(scores, -selected_depth)[-selected_depth:]
        local_indices = sorted(local_indices, key=lambda index: (-scores[index], identity(commits[allowed[index]])))
        output[case["id"]] = [
            {
                "rank": rank,
                "repo": commits[allowed[local_index]]["repo"],
                "id": commits[allowed[local_index]]["id"],
                "commitId": commits[allowed[local_index]]["commitId"],
                "score": float(scores[local_index]),
            }
            for rank, local_index in enumerate(local_indices, 1)
        ]
    return output


def base_candidates(case: dict[str, Any], raw: dict[str, Any], compact: dict[str, Any], depth: int) -> dict[str, list[str]]:
    candidates: dict[str, list[str]] = {}
    sources = (
        ("rawDense", raw[case["id"]]["channels"]["dense"]["topResults"][:depth]),
        ("rawLexical", raw[case["id"]]["channels"]["lexical"]["topResults"][:depth]),
        ("compactDense", compact[case["id"]]["channels"]["dense"]["topResults"][:depth]),
        ("compactLexical", compact[case["id"]]["channels"]["lexical"]["topResults"][:depth]),
    )
    for channel, results in sources:
        for result in results:
            candidates.setdefault(identity(result), []).append(channel)
    return candidates


def aggregate(rows: list[dict[str, Any]], split: str, key: str) -> dict[str, Any]:
    selected = [row for row in rows if row["split"] == split]
    recalls = [len(row["gold"] & row[key]) / len(row["gold"]) for row in selected]
    sizes = sorted(len(row[key]) for row in selected)
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
    if args.candidate_depth <= 0 or args.supplemental_depth <= 0:
        raise RuntimeError("candidate depths must be positive")
    cases = read_jsonl(args.dataset / "cases.jsonl")
    raw = {item["id"]: item for item in read_jsonl(args.raw_report / "case-results.jsonl")}
    compact = {item["id"]: item for item in read_jsonl(args.compact_report / "case-results.jsonl")}
    commits = load_commits(args.vectors_db)
    documents = [document_text(commit) for commit in commits]
    dev_queries = [str(case.get("query") or "") for case in cases if case.get("split") == "dev"]
    vectorizer = TfidfVectorizer(
        lowercase=True,
        analyzer="char_wb",
        ngram_range=(3, 5),
        min_df=2,
        max_features=60_000,
        sublinear_tf=True,
    )
    fit_matrix = vectorizer.fit_transform([*documents, *dev_queries])
    document_matrix = fit_matrix[:len(documents)]
    rankings = retrieve(cases, commits, vectorizer, document_matrix, args.supplemental_depth)

    rows = []
    details = []
    for case in cases:
        channels = base_candidates(case, raw, compact, args.candidate_depth)
        base = set(channels)
        for candidate in rankings[case["id"]]:
            channels.setdefault(identity(candidate), []).append("charTfidfTitle")
        augmented = set(channels)
        gold = {identity(item) for item in case["relevantCommits"]}
        rows.append({"id": case["id"], "split": case["split"], "gold": gold, "base": base, "augmented": augmented})
        details.append({
            "id": case["id"],
            "split": case["split"],
            "gold": sorted(gold),
            "basePoolSize": len(base),
            "augmentedPoolSize": len(augmented),
            "baseHit": bool(gold & base),
            "augmentedHit": bool(gold & augmented),
            "goldChannels": {key: channels[key] for key in gold if key in channels},
            "supplementalResults": rankings[case["id"]],
        })

    baseline = {split: aggregate(rows, split, "base") for split in ("dev", "test")}
    augmented = {split: aggregate(rows, split, "augmented") for split in ("dev", "test")}
    rescued = {
        split: [row["id"] for row in rows if row["split"] == split and not row["gold"] & row["base"] and row["gold"] & row["augmented"]]
        for split in ("dev", "test")
    }
    summary = {
        "schemaVersion": 1,
        "evaluationPolicy": "model-prescreened, non-gold, release-gate-ineligible",
        "selection": {
            "selectedOn": "dev",
            "channel": "character TF-IDF over issue title versus commit title/summary/areas/files",
            "supplementalDepth": args.supplemental_depth,
            "reason": "Best dev candidate-recall gain per pool-size increase in the frozen word/character raw/title ablation.",
        },
        "fitPolicy": {
            "corpusDocuments": len(documents),
            "devQueries": len(dev_queries),
            "testQueriesIncludedInFit": False,
            "analyzer": "char_wb",
            "ngramRange": [3, 5],
            "maximumFeatures": 60_000,
        },
        "basePool": {
            "channels": ["rawDense", "rawLexical", "compactDense", "compactLexical"],
            "depthPerChannel": args.candidate_depth,
            "metrics": baseline,
        },
        "augmentedPool": {"metrics": augmented},
        "rescuedCases": rescued,
    }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    (args.output / "case-results.jsonl").write_text(
        "\n".join(json.dumps(item) for item in details) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
