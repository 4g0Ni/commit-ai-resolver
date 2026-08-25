"""Encode eval queries with the same local Qwen contract used by the index builder."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from sentence_transformers import SentenceTransformer


PROJECT_ROOT = Path(__file__).resolve().parents[2]
MODEL_PATH = Path(os.environ.get("LOCAL_EMBEDDING_MODEL_PATH", PROJECT_ROOT / "data" / "models" / "Qwen3-Embedding-0.6B"))
INSTRUCTION = (
    "Instruct: Retrieve source-code commits that may explain the reported software symptom, "
    "regression, configuration change, or production incident.\nQuery: "
)


def main() -> None:
    payload = json.load(sys.stdin)
    queries = payload.get("queries", [])
    device = payload.get("device", os.environ.get("EVAL_EMBEDDING_DEVICE", "cuda"))
    model = SentenceTransformer(str(MODEL_PATH), device=device)
    embeddings = model.encode(
        [f"{INSTRUCTION}{query}" for query in queries],
        batch_size=int(payload.get("batchSize", 32)),
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    json.dump({"model": "Qwen/Qwen3-Embedding-0.6B", "dimensions": int(embeddings.shape[1]), "embeddings": embeddings.tolist()}, sys.stdout)


if __name__ == "__main__":
    main()

