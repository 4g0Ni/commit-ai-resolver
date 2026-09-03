"""Explore gold-independent TF-IDF fields as candidate-generation supplements.

The vectorizer is fit on the fixed commit corpus plus dev queries only. Explore
mode reports dev metrics for every configuration without reading test labels.
Frozen mode evaluates one named configuration and persists its rankings so the
selected channel can be combined with later rerankers.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer


CONFIGURATIONS = {
    "char-title-title-summary": ("char", "title", "title_summary"),
    "char-full-title-summary": ("char", "full", "title_summary"),
    "char-signal-title-summary": ("char", "signal", "title_summary"),
    "char-title-paths": ("char", "title", "paths"),
    "char-signal-paths": ("char", "signal", "paths"),
    "char-signal-areas-paths": ("char", "signal", "areas_paths"),
    "char-title-title-paths": ("char", "title", "title_paths"),
    "char-title-all-balanced": ("char", "title", "all_balanced"),
    "char-signal-all-balanced": ("char", "signal", "all_balanced"),
    "word-signal-title-summary": ("word", "signal", "title_summary"),
    "word-signal-paths": ("word", "signal", "paths"),
    "word-full-all-balanced": ("word", "full", "all_balanced"),
}
TECHNICAL_SIGNAL = re.compile(
    r"[A-Z0-9_$.]|error|crash|hang|suspend|render|hook|fiber|devtool|compiler|eslint",
    re.IGNORECASE,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--raw-report", type=Path, required=True)
    parser.add_argument("--compact-report", type=Path, required=True)
    parser.add_argument("--title-tfidf-report", type=Path, required=True)
    parser.add_argument("--vectors-db", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--split", choices=("dev", "test"), default="dev")
    parser.add_argument("--mode", choices=("explore", "frozen"), default="explore")
    parser.add_argument("--configuration", choices=tuple(CONFIGURATIONS))
    parser.add_argument("--base-depth", type=int, default=200)
    parser.add_argument("--title-tfidf-depth", type=int, default=50)
    parser.add_argument("--maximum-depth", type=int, default=100)
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
            "areas": [str(value) for value in metadata.get("affectedAreas") or []],
            "files": [str(value) for value in metadata.get("changedFiles") or []],
        })
    return commits


def split_words(value: str) -> str:
    value = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", value)
    return re.sub(r"[^A-Za-z0-9_$.-]+", " ", value)


def path_document(commit: dict[str, Any]) -> str:
    parts = []
    for path in commit["files"]:
        basename = path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        parts.extend((path, split_words(path), basename, split_words(basename), " ".join(re.split(r"[/_.-]+", path))))
    return " ".join(parts)


def document_text(commit: dict[str, Any], view: str) -> str:
    paths = path_document(commit)
    if view == "title_summary":
        return f"{commit['title']}\n{commit['summary']}"
    if view == "paths":
        return paths
    if view == "areas_paths":
        return f"{' '.join(commit['areas'])} {' '.join(commit['areas'])} {paths}"
    if view == "title_paths":
        return f"{commit['title']} {paths}"
    if view == "all_balanced":
        return f"{commit['title']}\n{commit['summary']}\n{' '.join(commit['areas'])}\n{paths}"
    raise RuntimeError(f"Unsupported document view: {view}")


def query_text(case: dict[str, Any], view: str) -> str:
    query = str(case.get("query") or "")
    title = query.splitlines()[0].strip()
    if view == "title":
        return title
    if view == "full":
        return query[:2500]
    candidates = []
    pattern = re.compile(r"`([^`]{2,80})`|\"([^\"\n]{2,100})\"|\b([A-Za-z_$][A-Za-z0-9_$.]{2,})\b")
    for match in pattern.findall(query):
        value = next((part for part in match if part), "")
        if TECHNICAL_SIGNAL.search(value) and value not in candidates:
            candidates.append(value)
    return f"{title} {' '.join(candidates)[:1200]}".strip()


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


def base_pool(
    case: dict[str, Any],
    raw: dict[str, Any],
    compact: dict[str, Any],
    title_tfidf: dict[str, Any],
    base_depth: int,
    title_depth: int,
) -> set[str]:
    pool = set()
    for report in (raw, compact):
        for channel in ("dense", "lexical"):
            pool.update(identity(item) for item in report[case["id"]]["channels"][channel]["topResults"][:base_depth])
    pool.update(identity(item) for item in title_tfidf[case["id"]]["supplementalResults"][:title_depth])
    return pool


def retrieve(
    cases: list[dict[str, Any]],
    commits: list[dict[str, Any]],
    analyzer: str,
    query_view: str,
    document_view: str,
    dev_cases: list[dict[str, Any]],
    depth: int,
) -> tuple[dict[str, list[dict[str, Any]]], int]:
    documents = [document_text(commit, document_view) for commit in commits]
    dev_queries = [query_text(case, query_view) for case in dev_cases]
    options: dict[str, Any] = {
        "lowercase": True,
        "min_df": 2,
        "sublinear_tf": True,
        "max_features": 60_000,
        "dtype": np.float32,
    }
    if analyzer == "char":
        options.update(analyzer="char_wb", ngram_range=(3, 5))
    else:
        options.update(
            analyzer="word",
            ngram_range=(1, 2),
            token_pattern=r"(?u)\b[A-Za-z_$][A-Za-z0-9_$.\-/]{1,}\b",
        )
    vectorizer = TfidfVectorizer(**options)
    fit_matrix = vectorizer.fit_transform([*documents, *dev_queries])
    document_matrix = fit_matrix[:len(documents)]
    query_matrix = vectorizer.transform([query_text(case, query_view) for case in cases])
    rankings = {}
    for case_index, case in enumerate(cases):
        allowed = np.asarray(
            [index for index, commit in enumerate(commits) if matches_filters(commit, case.get("filters") or {})],
            dtype=np.int32,
        )
        scores = (query_matrix[case_index] @ document_matrix[allowed].T).toarray().ravel()
        positive = np.flatnonzero(scores > 0)
        selected_depth = min(depth, len(positive))
        if selected_depth:
            local_indices = positive[np.argpartition(scores[positive], -selected_depth)[-selected_depth:]]
            local_indices = sorted(local_indices, key=lambda index: (-scores[index], identity(commits[allowed[index]])))
        else:
            local_indices = []
        rankings[case["id"]] = [
            {
                "rank": rank,
                "repo": commits[allowed[local_index]]["repo"],
                "id": commits[allowed[local_index]]["id"],
                "commitId": commits[allowed[local_index]]["commitId"],
                "score": float(scores[local_index]),
            }
            for rank, local_index in enumerate(local_indices, 1)
        ]
    return rankings, len(vectorizer.vocabulary_)


def aggregate(cases: list[dict[str, Any]], pools: dict[str, set[str]]) -> dict[str, Any]:
    recalls = []
    sizes = []
    for case in cases:
        gold = {identity(item) for item in case["relevantCommits"]}
        pool = pools[case["id"]]
        recalls.append(len(gold & pool) / len(gold))
        sizes.append(len(pool))
    sizes.sort()
    return {
        "cases": len(cases),
        "recall": sum(recalls) / len(recalls),
        "hitRate": sum(value > 0 for value in recalls) / len(recalls),
        "missedCases": sum(value == 0 for value in recalls),
        "averagePoolSize": sum(sizes) / len(sizes),
        "p95PoolSize": sizes[min(len(sizes) - 1, math.floor(len(sizes) * 0.95))],
    }


def main() -> None:
    args = parse_args()
    if args.mode == "explore" and args.split != "dev":
        raise RuntimeError("explore mode is dev-only")
    if args.mode == "frozen" and not args.configuration:
        raise RuntimeError("frozen mode requires --configuration")
    all_cases = read_jsonl(args.dataset / "cases.jsonl")
    cases = [case for case in all_cases if case.get("split") == args.split]
    dev_cases = [case for case in all_cases if case.get("split") == "dev"]
    commits = load_commits(args.vectors_db)
    raw = {item["id"]: item for item in read_jsonl(args.raw_report / "case-results.jsonl")}
    compact = {item["id"]: item for item in read_jsonl(args.compact_report / "case-results.jsonl")}
    title_tfidf = {item["id"]: item for item in read_jsonl(args.title_tfidf_report / "case-results.jsonl")}
    base = {
        case["id"]: base_pool(case, raw, compact, title_tfidf, args.base_depth, args.title_tfidf_depth)
        for case in cases
    }
    configurations = [args.configuration] if args.configuration else list(CONFIGURATIONS)
    depths = [args.maximum_depth] if args.mode == "frozen" else sorted({25, 50, args.maximum_depth})
    summaries = {}
    frozen_rankings = None
    for name in configurations:
        started = time.perf_counter()
        analyzer, query_view, document_view = CONFIGURATIONS[name]
        rankings, features = retrieve(cases, commits, analyzer, query_view, document_view, dev_cases, args.maximum_depth)
        depth_metrics = {}
        for depth in depths:
            pools = {
                case["id"]: base[case["id"]] | {identity(item) for item in rankings[case["id"]][:depth]}
                for case in cases
            }
            rescued = []
            for case in cases:
                gold = {identity(item) for item in case["relevantCommits"]}
                if not gold & base[case["id"]] and gold & pools[case["id"]]:
                    rescued.append(case["id"])
            depth_metrics[str(depth)] = {"metrics": aggregate(cases, pools), "rescuedCases": rescued}
        summaries[name] = {
            "analyzer": analyzer,
            "queryView": query_view,
            "documentView": document_view,
            "features": features,
            "elapsedSeconds": time.perf_counter() - started,
            "depths": depth_metrics,
        }
        print(json.dumps({"configuration": name, **summaries[name]}, indent=2), file=sys.stderr, flush=True)
        if args.mode == "frozen":
            frozen_rankings = rankings

    summary = {
        "schemaVersion": 1,
        "evaluationPolicy": "model-prescreened, non-gold, release-gate-ineligible",
        "split": args.split,
        "mode": args.mode,
        "selectionPolicy": "Explore configurations on dev only; freeze one name and depth before reading test.",
        "fitPolicy": {"corpusDocuments": len(commits), "devQueries": len(dev_cases), "testQueriesIncludedInFit": False},
        "basePool": {
            "rawCompactDepthPerChannel": args.base_depth,
            "titleTfidfDepth": args.title_tfidf_depth,
            "metrics": aggregate(cases, base),
        },
        "configurations": summaries,
    }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    if frozen_rankings is not None:
        (args.output / "case-results.jsonl").write_text(
            "\n".join(json.dumps({
                "id": case["id"],
                "split": case["split"],
                "gold": [identity(item) for item in case["relevantCommits"]],
                "basePoolSize": len(base[case["id"]]),
                "supplementalResults": frozen_rankings[case["id"]],
            }) for case in cases) + "\n",
            encoding="utf-8",
        )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
