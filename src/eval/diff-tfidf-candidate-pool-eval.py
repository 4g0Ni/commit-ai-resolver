"""Retrieve commits from test/fixture diff text with character TF-IDF.

Patch snippets are extracted for every corpus commit from the local bare React
repository. Only added lines in test or fixture paths are retained, and issue,
PR, commit numbers, URLs, and SHAs are removed so provenance identifiers cannot
become a shortcut. The vectorizer is fit on corpus snippets plus dev queries;
test queries are transform-only.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sqlite3
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer


RECORD_PREFIX = "\x1e"
URL = re.compile(r"https?://\S+", re.IGNORECASE)
REFERENCE = re.compile(r"(?:(?:issue|pull request|pr|commit)\s*)?#\d+\b", re.IGNORECASE)
SHA = re.compile(r"\b[0-9a-f]{7,40}\b", re.IGNORECASE)
HIGH_SIGNAL = re.compile(
    r"(?:\b(?:it|test|describe|expect|assert|throw|error|warning|regression|hydrate|render|suspend|crash)\b|"
    r"[A-Za-z_$][A-Za-z0-9_$]*\(|['\"`][^'\"`]{4,}['\"`])",
    re.IGNORECASE,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--raw-report", type=Path, required=True)
    parser.add_argument("--compact-report", type=Path, required=True)
    parser.add_argument("--title-tfidf-report", type=Path, required=True)
    parser.add_argument("--vectors-db", type=Path, required=True)
    parser.add_argument("--git-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--snippet-cache", type=Path)
    parser.add_argument("--split", choices=("dev", "test"), required=True)
    parser.add_argument("--mode", choices=("explore", "frozen"), default="explore")
    parser.add_argument("--base-depth", type=int, default=100)
    parser.add_argument("--title-tfidf-depth", type=int, default=50)
    parser.add_argument("--diff-depth", type=int, default=100)
    parser.add_argument("--maximum-snippet-chars", type=int, default=12_000)
    parser.add_argument("--extraction-batch-size", type=int, default=500)
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
            "files": [str(value) for value in metadata.get("changedFiles") or []],
        })
    return commits


def sanitize_line(value: str) -> str:
    cleaned = URL.sub(" ", value)
    cleaned = REFERENCE.sub(" ", cleaned)
    cleaned = SHA.sub(" ", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()[:500]


def has_candidate_path(commit: dict[str, Any]) -> bool:
    return any("test" in path.lower() or "fixture" in path.lower() for path in commit["files"])


def extract_snippet_batch(git_dir: Path, commits: list[dict[str, Any]], maximum_chars: int) -> dict[str, str]:
    command = [
        "git", "--git-dir", str(git_dir), "diff-tree", "--stdin", "--root", "--format=%x1e%H", "-p",
        "--unified=0", "--no-color", "--no-ext-diff", "--no-renames", "--diff-filter=AM", "--",
        ":(icase,glob)**/*test*", ":(icase,glob)**/*fixture*",
    ]
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    def write_ids() -> None:
        assert process.stdin is not None
        try:
            for commit in commits:
                process.stdin.write(f"{commit['commitId']}\n")
            process.stdin.close()
        except BrokenPipeError:
            pass

    writer = threading.Thread(target=write_ids, daemon=True)
    writer.start()
    snippets = {commit["commitId"].lower(): "" for commit in commits}
    current_id = ""
    current_path = ""
    paths: list[str] = []
    high: list[str] = []
    normal: list[str] = []

    def flush() -> None:
        if not current_id:
            return
        ordered = [*(f"File: {path}" for path in paths), *high, *normal]
        selected = []
        size = 0
        for line in ordered:
            if size + len(line) + 1 > maximum_chars:
                continue
            selected.append(line)
            size += len(line) + 1
        snippets[current_id] = "\n".join(selected)

    assert process.stdout is not None
    for raw_line in process.stdout:
        line = raw_line.rstrip("\r\n")
        if line.startswith(RECORD_PREFIX):
            flush()
            current_id = line[1:].strip().lower()
            current_path = ""
            paths, high, normal = [], [], []
            continue
        if line.startswith("+++ b/"):
            current_path = line[6:]
            if current_path and current_path not in paths:
                paths.append(current_path)
            continue
        if not current_id or not line.startswith("+") or line.startswith("+++"):
            continue
        cleaned = sanitize_line(line[1:])
        if len(cleaned) < 3 or cleaned in ("{}", "();", ");"):
            continue
        rendered = f"{current_path}: {cleaned}" if current_path else cleaned
        (high if HIGH_SIGNAL.search(cleaned) else normal).append(rendered)
    flush()
    writer.join(timeout=10)
    stderr = process.stderr.read() if process.stderr else ""
    return_code = process.wait()
    if return_code != 0:
        raise RuntimeError(f"git diff extraction failed ({return_code}): {stderr[-2000:]}")
    return snippets


def read_snippet_cache(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    snippets = {}
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line:
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            print(f"Ignoring incomplete cache line {line_number} in {path}", file=sys.stderr)
            continue
        snippets[str(item["commitId"]).lower()] = str(item.get("text") or "")
    return snippets


def append_snippet_cache(path: Path, commits: list[dict[str, Any]], snippets: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    needs_separator = False
    if path.exists() and path.stat().st_size > 0:
        with path.open("rb") as existing:
            existing.seek(-1, 2)
            needs_separator = existing.read(1) != b"\n"
    with path.open("a", encoding="utf-8") as handle:
        if needs_separator:
            handle.write("\n")
        for commit in commits:
            commit_id = commit["commitId"].lower()
            handle.write(json.dumps({"commitId": commit_id, "text": snippets.get(commit_id, "")}) + "\n")


def load_or_extract_snippets(
    git_dir: Path,
    commits: list[dict[str, Any]],
    maximum_chars: int,
    cache_path: Path,
    batch_size: int,
) -> dict[str, str]:
    snippets = read_snippet_cache(cache_path)
    eligible = [commit for commit in commits if has_candidate_path(commit)]
    missing = [commit for commit in eligible if commit["commitId"].lower() not in snippets]
    if not missing:
        print(f"Diff snippet cache complete: {len(eligible)} eligible commits", file=sys.stderr)
        return snippets

    print(
        f"Extracting diff snippets for {len(missing)} missing of {len(eligible)} eligible commits "
        f"in batches of {batch_size}",
        file=sys.stderr,
        flush=True,
    )
    for start in range(0, len(missing), batch_size):
        batch = missing[start:start + batch_size]
        extracted = extract_snippet_batch(git_dir, batch, maximum_chars)
        append_snippet_cache(cache_path, batch, extracted)
        snippets.update(extracted)
        print(
            f"Cached {min(start + len(batch), len(missing))}/{len(missing)} missing commits; "
            f"{sum(bool(value) for value in snippets.values())} non-empty snippets",
            file=sys.stderr,
            flush=True,
        )
    return snippets


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
    if args.extraction_batch_size <= 0:
        raise RuntimeError("extraction batch size must be positive")
    cases_all = read_jsonl(args.dataset / "cases.jsonl")
    cases = [case for case in cases_all if case.get("split") == args.split]
    commits = load_commits(args.vectors_db)
    raw = {item["id"]: item for item in read_jsonl(args.raw_report / "case-results.jsonl")}
    compact = {item["id"]: item for item in read_jsonl(args.compact_report / "case-results.jsonl")}
    title_tfidf = {item["id"]: item for item in read_jsonl(args.title_tfidf_report / "case-results.jsonl")}

    cache_path = args.snippet_cache or args.output / "diff-snippets.jsonl"
    snippets = load_or_extract_snippets(
        args.git_dir,
        commits,
        args.maximum_snippet_chars,
        cache_path,
        args.extraction_batch_size,
    )

    documents = [snippets.get(commit["commitId"].lower(), "") for commit in commits]
    dev_queries = [str(case.get("query") or "") for case in cases_all if case.get("split") == "dev"]
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
    rankings = retrieve(cases, commits, vectorizer, document_matrix, args.diff_depth)
    base = {
        case["id"]: base_pool(case, raw, compact, title_tfidf, args.base_depth, args.title_tfidf_depth)
        for case in cases
    }

    depths = [args.diff_depth] if args.mode == "frozen" else sorted({value for value in (10, 25, 50, args.diff_depth) if value <= args.diff_depth})
    configurations = {}
    for depth in depths:
        augmented = {
            case["id"]: base[case["id"]] | {identity(item) for item in rankings[case["id"]][:depth]}
            for case in cases
        }
        rescued = []
        for case in cases:
            gold = {identity(item) for item in case["relevantCommits"]}
            if not gold & base[case["id"]] and gold & augmented[case["id"]]:
                rescued.append(case["id"])
        configurations[str(depth)] = {"depth": depth, "metrics": aggregate(cases, augmented), "rescuedCases": rescued}

    summary = {
        "schemaVersion": 1,
        "evaluationPolicy": "model-prescreened, non-gold, release-gate-ineligible",
        "split": args.split,
        "mode": args.mode,
        "snippetPolicy": {
            "paths": ["**/*test*", "**/*fixture*"],
            "lines": "added lines only; identifiers/URLs/SHAs removed",
            "maximumCharsPerCommit": args.maximum_snippet_chars,
            "commitsWithCandidatePaths": sum(has_candidate_path(commit) for commit in commits),
            "commitsWithSnippets": sum(bool(value) for value in documents),
            "cache": str(cache_path),
        },
        "fitPolicy": {"corpusDocuments": len(documents), "devQueries": len(dev_queries), "testQueriesIncludedInFit": False},
        "basePool": {
            "rawCompactDepthPerChannel": args.base_depth,
            "titleTfidfDepth": args.title_tfidf_depth,
            "metrics": aggregate(cases, base),
        },
        "configurations": configurations,
    }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "case-results.jsonl").write_text(
        "\n".join(json.dumps({
            "id": case["id"],
            "split": case["split"],
            "gold": [identity(item) for item in case["relevantCommits"]],
            "basePoolSize": len(base[case["id"]]),
            "supplementalResults": rankings[case["id"]],
        }) for case in cases) + "\n",
        encoding="utf-8",
    )
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
