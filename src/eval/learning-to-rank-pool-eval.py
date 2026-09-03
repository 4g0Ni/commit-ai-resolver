"""Evaluate a cheap supervised reranker over pooled retrieval candidates.

The model is trained only on the pilot dev split.  Model selection uses a
deterministic, commit-grouped holdout inside dev; the published test split is
scored only after the winning configuration has been selected and refit.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sqlite3
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.ensemble import ExtraTreesClassifier, HistGradientBoostingClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression


CHANNELS = ("rawDense", "rawLexical", "compactDense", "compactLexical")
TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9_.:/#-]*|\d+")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rerank a raw/compact retrieval pool with dev-trained features")
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--raw-report", type=Path, required=True)
    parser.add_argument("--compact-report", type=Path, required=True)
    parser.add_argument("--vectors-db", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--candidate-depth", type=int, default=100)
    return parser.parse_args()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def identity(item: dict[str, Any]) -> str:
    return f"{item.get('repo', '')}:{item.get('commitId') or item.get('id', '')}"


def short_identity(item: dict[str, Any]) -> str:
    return f"{item.get('repo', '')}:{item.get('id') or str(item.get('commitId', ''))[:8]}"


def load_metadata(path: Path) -> dict[str, dict[str, Any]]:
    db = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    try:
        rows = db.execute("SELECT repo, id, commitId, text, metadata FROM commit_metadata").fetchall()
    finally:
        db.close()
    return {
        f"{repo}:{short_id}": {
            "repo": repo,
            "id": short_id,
            "commitId": commit_id,
            "text": text or "",
            "metadata": json.loads(metadata),
        }
        for repo, short_id, commit_id, text, metadata in rows
    }


def document_text(record: dict[str, Any]) -> str:
    metadata = record["metadata"]
    return "\n".join(filter(None, [
        str(metadata.get("title", "")),
        str(metadata.get("summary", "")),
        " ".join(metadata.get("affectedAreas") or []),
        " ".join(metadata.get("changedFiles") or []),
    ]))


def terms(value: str) -> set[str]:
    expanded = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", value)
    output = set()
    for raw in TOKEN.findall(expanded):
        lowered = raw.lower().strip("._:/#-")
        if len(lowered) >= 2:
            output.add(lowered)
            output.update(part for part in re.split(r"[._:/#-]+", lowered) if len(part) >= 2)
    return output


def overlap(left: set[str], right: set[str]) -> tuple[float, float, float]:
    if not left or not right:
        return 0.0, 0.0, 0.0
    shared = len(left & right)
    return shared / len(left), shared / len(right), shared / len(left | right)


def reciprocal(rank: int | None) -> float:
    return 1 / rank if rank else 0.0


def ranking_metrics(ranked: list[dict[str, Any]], gold: set[str], limit: int) -> dict[str, float]:
    hits = [index for index, item in enumerate(ranked[:limit]) if identity(item) in gold]
    recall = len(hits) / len(gold)
    mrr = 1 / (hits[0] + 1) if hits else 0.0
    dcg = sum(7 / math.log2(index + 2) for index in hits)
    idcg = sum(7 / math.log2(index + 2) for index in range(min(len(gold), limit)))
    return {"recall": recall, "mrr": mrr, "ndcg": dcg / idcg}


def aggregate(rows: list[dict[str, Any]], ranking: str, split: str | None = None) -> dict[str, float]:
    selected = [row for row in rows if split is None or row["split"] == split]
    output: dict[str, float] = {"cases": len(selected)}
    for limit in (10, 20, 50, 100):
        values = [ranking_metrics(row[ranking], row["gold"], limit) for row in selected]
        for metric in ("recall", "mrr", "ndcg"):
            output[f"{metric}At{limit}"] = sum(value[metric] for value in values) / len(values)
    return output


def candidate_availability(rows: list[dict[str, Any]], split: str | None = None) -> dict[str, float]:
    selected = [row for row in rows if split is None or row["split"] == split]
    recalls = [len(row["gold"] & {identity(item) for item in row["pool"]}) / len(row["gold"]) for row in selected]
    sizes = sorted(len(row["pool"]) for row in selected)
    return {
        "cases": len(selected),
        "recall": sum(recalls) / len(recalls),
        "hitRate": sum(value > 0 for value in recalls) / len(recalls),
        "missedCases": sum(value == 0 for value in recalls),
        "averagePoolSize": sum(sizes) / len(sizes),
        "p95PoolSize": sizes[min(len(sizes) - 1, math.floor(len(sizes) * 0.95))],
        "maximumPoolSize": sizes[-1],
    }


def make_rows(cases: list[dict[str, Any]], raw: dict[str, Any], compact: dict[str, Any], metadata: dict[str, Any], depth: int) -> list[dict[str, Any]]:
    source_spec = (
        ("rawDense", raw, "dense"),
        ("rawLexical", raw, "lexical"),
        ("compactDense", compact, "dense"),
        ("compactLexical", compact, "lexical"),
    )
    rows = []
    for case in cases:
        pool: dict[str, dict[str, Any]] = {}
        for channel_name, report, result_name in source_spec:
            results = report[case["id"]]["channels"][result_name]["topResults"][:depth]
            scores = np.asarray([float(item.get("score") or 0) for item in results], dtype=float)
            low, high = (float(scores.min()), float(scores.max())) if len(scores) else (0.0, 0.0)
            span = high - low
            for rank, result in enumerate(results, 1):
                record = metadata.get(short_identity(result))
                if record is None:
                    raise RuntimeError(f"Missing metadata for {short_identity(result)}")
                item = pool.setdefault(identity(record), {**record, "ranks": {}, "scores": {}})
                score = float(result.get("score") or 0)
                item["ranks"][channel_name] = rank
                item["scores"][channel_name] = (score - low) / span if span else 0.0
        rows.append({
            "id": case["id"],
            "split": case["split"],
            "query": str(case["query"]),
            "gold": {identity(item) for item in case["relevantCommits"]},
            "pool": list(pool.values()),
        })
    return rows


def build_features(rows: list[dict[str, Any]], corpus_documents: list[str]) -> tuple[np.ndarray, np.ndarray, list[tuple[int, int]], list[str]]:
    unique_documents: dict[str, str] = {}
    for row in rows:
        for item in row["pool"]:
            unique_documents[identity(item)] = document_text(item)
    document_keys = list(unique_documents)
    document_values = [unique_documents[key] for key in document_keys]
    queries = [row["query"] for row in rows]
    # Fit unsupervised text statistics on the fixed commit corpus and dev queries
    # only. Test queries are transformed but never included in vocabulary/IDF
    # estimation, avoiding transductive leakage from the held-out split.
    fit_corpus = [row["query"] for row in rows if row["split"] == "dev"] + corpus_documents

    word = TfidfVectorizer(lowercase=True, ngram_range=(1, 2), min_df=2, max_features=90_000, sublinear_tf=True)
    char = TfidfVectorizer(lowercase=True, analyzer="char_wb", ngram_range=(3, 5), min_df=2, max_features=60_000, sublinear_tf=True)
    word.fit(fit_corpus)
    char.fit(fit_corpus)
    query_word_matrix = word.transform(queries)
    query_char_matrix = char.transform(queries)
    document_word_matrix = word.transform(document_values)
    document_char_matrix = char.transform(document_values)
    document_index = {key: index for index, key in enumerate(document_keys)}

    feature_names = []
    for channel in CHANNELS:
        feature_names.extend((f"{channel}Present", f"{channel}ReciprocalRank", f"{channel}RelativeScore"))
    feature_names.extend((
        "channelCount", "bestReciprocalRank", "rrf20", "denseConsensus", "lexicalConsensus",
        "wordTfidfCosine", "charTfidfCosine",
        "queryToTitle", "titleToQuery", "queryTitleJaccard",
        "queryToSummary", "summaryToQuery", "querySummaryJaccard",
        "queryToFiles", "filesToQuery", "queryFilesJaccard",
        "queryToAreas", "areasToQuery", "queryAreasJaccard",
        "exactTitleInQuery", "exactAreaInQuery", "documentLengthLog", "queryLengthLog",
    ))

    matrix: list[list[float]] = []
    labels: list[int] = []
    coordinates: list[tuple[int, int]] = []
    for row_index, row in enumerate(rows):
        query_terms = terms(row["query"])
        query_title = row["query"].splitlines()[0] if row["query"].splitlines() else row["query"]
        query_title_terms = terms(query_title)
        query_vector = query_word_matrix[row_index]
        query_char_vector = query_char_matrix[row_index]
        for item_index, item in enumerate(row["pool"]):
            metadata = item["metadata"]
            title = str(metadata.get("title", ""))
            summary = str(metadata.get("summary", ""))
            files = " ".join(metadata.get("changedFiles") or [])
            areas = " ".join(metadata.get("affectedAreas") or [])
            ranks = item["ranks"]
            features: list[float] = []
            for channel in CHANNELS:
                rank = ranks.get(channel)
                features.extend((float(rank is not None), reciprocal(rank), item["scores"].get(channel, 0.0)))
            reciprocal_ranks = [reciprocal(ranks.get(channel)) for channel in CHANNELS]
            features.extend((
                float(len(ranks)), max(reciprocal_ranks), sum(1 / (20 + rank) for rank in ranks.values()),
                float("rawDense" in ranks and "compactDense" in ranks),
                float("rawLexical" in ranks and "compactLexical" in ranks),
            ))
            doc_row = document_index[identity(item)]
            features.extend((
                float(query_vector.multiply(document_word_matrix[doc_row]).sum()),
                float(query_char_vector.multiply(document_char_matrix[doc_row]).sum()),
            ))
            for candidate_terms in (terms(title), terms(summary), terms(files), terms(areas)):
                features.extend(overlap(query_terms, candidate_terms))
            title_lower = title.lower().strip()
            area_lower = areas.lower().strip()
            features.extend((
                float(bool(title_lower) and title_lower in row["query"].lower()),
                float(bool(area_lower) and area_lower in row["query"].lower()),
                math.log1p(len(unique_documents[identity(item)])),
                math.log1p(len(row["query"])),
            ))
            # A title-specific overlap is more useful than whole-query coverage for
            # long issue templates, so replace the three generic title values.
            title_values = overlap(query_title_terms, terms(title))
            title_start = len(CHANNELS) * 3 + 7
            features[title_start:title_start + 3] = title_values
            matrix.append(features)
            labels.append(int(identity(item) in row["gold"]))
            coordinates.append((row_index, item_index))
    return np.asarray(matrix, dtype=np.float32), np.asarray(labels, dtype=np.int8), coordinates, feature_names


def internal_dev_partition(rows: list[dict[str, Any]]) -> tuple[set[int], set[int]]:
    dev_indices = [index for index, row in enumerate(rows) if row["split"] == "dev"]
    parent = {index: index for index in dev_indices}

    def find(value: int) -> int:
        while parent[value] != value:
            parent[value] = parent[parent[value]]
            value = parent[value]
        return value

    def union(left: int, right: int) -> None:
        left_root, right_root = find(left), find(right)
        if left_root != right_root:
            parent[right_root] = left_root

    owner: dict[str, int] = {}
    for index in dev_indices:
        for commit in rows[index]["gold"]:
            if commit in owner:
                union(index, owner[commit])
            else:
                owner[commit] = index
    components: dict[int, list[int]] = {}
    for index in dev_indices:
        components.setdefault(find(index), []).append(index)
    validation: set[int] = set()
    for members in components.values():
        token = "|".join(sorted(rows[index]["id"] for index in members))
        if int(hashlib.sha256(token.encode()).hexdigest()[:8], 16) % 4 == 0:
            validation.update(members)
    return set(dev_indices) - validation, validation


def examples_for_cases(coordinates: list[tuple[int, int]], selected: set[int], labels: np.ndarray) -> np.ndarray:
    cases_with_positive = {case for (case, _), label in zip(coordinates, labels, strict=True) if label and case in selected}
    return np.asarray([index for index, (case, _) in enumerate(coordinates) if case in cases_with_positive], dtype=int)


def sample_weights(indices: np.ndarray, coordinates: list[tuple[int, int]], labels: np.ndarray) -> np.ndarray:
    by_case: dict[int, list[int]] = {}
    for global_index in indices:
        by_case.setdefault(coordinates[global_index][0], []).append(global_index)
    weights = np.zeros(len(indices), dtype=np.float32)
    position = {global_index: local_index for local_index, global_index in enumerate(indices)}
    for case_indices in by_case.values():
        positives = [index for index in case_indices if labels[index]]
        negatives = [index for index in case_indices if not labels[index]]
        for index in positives:
            weights[position[index]] = 0.5 / len(positives)
        for index in negatives:
            weights[position[index]] = 0.5 / len(negatives)
    return weights


def model_candidates() -> list[tuple[str, Any]]:
    return [
        *[(f"logistic-c{value}", LogisticRegression(C=value, max_iter=500, solver="liblinear")) for value in (0.05, 0.2, 1, 5)],
        ("hist-depth3", HistGradientBoostingClassifier(max_iter=160, learning_rate=0.06, max_depth=3, l2_regularization=1, random_state=42)),
        ("hist-leaves15", HistGradientBoostingClassifier(max_iter=160, learning_rate=0.06, max_leaf_nodes=15, l2_regularization=2, random_state=42)),
        ("extra-depth8", ExtraTreesClassifier(n_estimators=240, max_depth=8, min_samples_leaf=3, class_weight="balanced", n_jobs=-1, random_state=42)),
        ("extra-depth12", ExtraTreesClassifier(n_estimators=240, max_depth=12, min_samples_leaf=2, class_weight="balanced", n_jobs=-1, random_state=42)),
    ]


def assign_ranking(rows: list[dict[str, Any]], scores: np.ndarray, coordinates: list[tuple[int, int]], name: str) -> None:
    per_case: dict[int, list[tuple[float, dict[str, Any]]]] = {}
    for score, (case_index, item_index) in zip(scores, coordinates, strict=True):
        item = rows[case_index]["pool"][item_index]
        item[f"{name}Score"] = float(score)
        per_case.setdefault(case_index, []).append((float(score), item))
    for case_index, row in enumerate(rows):
        row[name] = [item for _, item in sorted(per_case[case_index], key=lambda pair: pair[0], reverse=True)]


def main() -> None:
    args = parse_args()
    cases = read_jsonl(args.dataset / "cases.jsonl")
    raw = {item["id"]: item for item in read_jsonl(args.raw_report / "case-results.jsonl")}
    compact = {item["id"]: item for item in read_jsonl(args.compact_report / "case-results.jsonl")}
    metadata = load_metadata(args.vectors_db)
    rows = make_rows(cases, raw, compact, metadata, args.candidate_depth)
    features, labels, coordinates, feature_names = build_features(
        rows,
        [document_text(record) for record in metadata.values()],
    )
    train_cases, validation_cases = internal_dev_partition(rows)
    train = examples_for_cases(coordinates, train_cases, labels)
    validation_rows = [rows[index] for index in sorted(validation_cases)]
    search = []
    for name, model in model_candidates():
        model.fit(features[train], labels[train], sample_weight=sample_weights(train, coordinates, labels))
        scores = model.predict_proba(features)[:, 1]
        assign_ranking(rows, scores, coordinates, "validationRanking")
        metrics = aggregate(validation_rows, "validationRanking")
        objective = metrics["recallAt20"] + 0.15 * metrics["mrrAt10"] + 0.05 * metrics["ndcgAt20"]
        search.append({"name": name, "objective": objective, "metrics": metrics})
    search.sort(key=lambda item: item["objective"], reverse=True)
    selected_name = search[0]["name"]
    selected_model = dict(model_candidates())[selected_name]
    all_dev_cases = {index for index, row in enumerate(rows) if row["split"] == "dev"}
    all_dev = examples_for_cases(coordinates, all_dev_cases, labels)
    selected_model.fit(features[all_dev], labels[all_dev], sample_weight=sample_weights(all_dev, coordinates, labels))
    final_scores = selected_model.predict_proba(features)[:, 1]
    assign_ranking(rows, final_scores, coordinates, "learnedReranker")

    # Preserve raw-dense insertion order as a diagnostic baseline. Candidate
    # availability below is the ranking-independent hard upper bound.
    for row in rows:
        row["rawDenseSeedOrder"] = row["pool"]
    summary = {
        "schemaVersion": 1,
        "evaluationPolicy": "model-prescreened, non-gold, release-gate-ineligible",
        "candidateDepthPerSource": args.candidate_depth,
        "averagePoolSize": sum(len(row["pool"]) for row in rows) / len(rows),
        "featureCount": len(feature_names),
        "featureNames": feature_names,
        "candidateAvailability": {
            "all": candidate_availability(rows),
            "dev": candidate_availability(rows, "dev"),
            "test": candidate_availability(rows, "test"),
        },
        "training": {
            "devCases": len(all_dev_cases),
            "internalTrainCases": len(train_cases),
            "internalValidationCases": len(validation_cases),
            "selectedModel": selected_name,
            "selection": search,
        },
        "metrics": {
            ranking: {
                "all": aggregate(rows, ranking),
                "dev": aggregate(rows, ranking, "dev"),
                "test": aggregate(rows, ranking, "test"),
            }
            for ranking in ("rawDenseSeedOrder", "learnedReranker")
        },
    }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    (args.output / "case-results.jsonl").write_text(
        "\n".join(json.dumps({
            "id": row["id"],
            "split": row["split"],
            "gold": sorted(row["gold"]),
            "poolSize": len(row["pool"]),
            "learnedReranker": [
                {
                    "rank": rank,
                    "repo": item["repo"],
                    "id": item["id"],
                    "commitId": item["commitId"],
                    "score": item["learnedRerankerScore"],
                    "sourceRanks": item["ranks"],
                }
                for rank, item in enumerate(row["learnedReranker"], 1)
            ],
        }) for row in rows) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"selectedModel": selected_name, "metrics": summary["metrics"]}, indent=2))


if __name__ == "__main__":
    main()
