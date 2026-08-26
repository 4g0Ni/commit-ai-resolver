"""Serve the local Qwen embedding model through an OpenAI-compatible endpoint."""

from __future__ import annotations

import argparse
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict
from sentence_transformers import SentenceTransformer


PROJECT_ROOT = Path(__file__).resolve().parents[2]
MODEL_ID = os.environ.get("LOCAL_EMBEDDING_MODEL_ID", "Qwen/Qwen3-Embedding-0.6B")
MODEL_PATH = Path(
    os.environ.get(
        "LOCAL_EMBEDDING_MODEL_PATH",
        PROJECT_ROOT / "data" / "models" / "Qwen3-Embedding-0.6B",
    )
)
EMBEDDING_DIMENSIONS = 1024


class EmbeddingRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    input: str | list[str]
    model: str = MODEL_ID


class ModelState:
    model: SentenceTransformer | None = None
    device: str = "cpu"


state = ModelState()


def load_model(device: str) -> SentenceTransformer:
    if not (MODEL_PATH / "model.safetensors").is_file():
        raise RuntimeError(
            f"Local embedding model not found at {MODEL_PATH}. "
            "Run src/scripts/generate-embedding.py once to download it."
        )
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but PyTorch cannot see a GPU.")
    model_kwargs = {"dtype": torch.float16} if device == "cuda" else {}
    model = SentenceTransformer(str(MODEL_PATH), device=device, model_kwargs=model_kwargs)
    dimensions = model.get_embedding_dimension()
    if dimensions != EMBEDDING_DIMENSIONS:
        raise RuntimeError(
            f"Model outputs {dimensions} dimensions; expected {EMBEDDING_DIMENSIONS}."
        )
    return model


def create_app(device: str = "cuda") -> FastAPI:
    @asynccontextmanager
    async def lifespan(_: FastAPI):
        state.device = device
        state.model = load_model(device)
        yield
        state.model = None

    app = FastAPI(title="Commit Resolver Local Embeddings", lifespan=lifespan)

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {
            "status": "ok" if state.model is not None else "loading",
            "model": MODEL_ID,
            "dimensions": EMBEDDING_DIMENSIONS,
            "device": state.device,
        }

    @app.get("/v1/models")
    def models() -> dict[str, Any]:
        return {
            "object": "list",
            "data": [{"id": MODEL_ID, "object": "model", "owned_by": "local"}],
        }

    @app.post("/v1/embeddings")
    def embeddings(request: EmbeddingRequest) -> dict[str, Any]:
        if request.model != MODEL_ID:
            raise HTTPException(status_code=400, detail=f"Unsupported model: {request.model}")
        texts = [request.input] if isinstance(request.input, str) else request.input
        if not texts or any(not isinstance(text, str) or not text.strip() for text in texts):
            raise HTTPException(status_code=400, detail="input must contain non-empty strings")
        if state.model is None:
            raise HTTPException(status_code=503, detail="Model is not loaded")
        encoded = state.model.encode(
            texts,
            batch_size=min(len(texts), 32),
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        token_count = sum(len(state.model.tokenizer.encode(text)) for text in texts)
        return {
            "object": "list",
            "data": [
                {"object": "embedding", "index": index, "embedding": vector.tolist()}
                for index, vector in enumerate(encoded)
            ],
            "model": MODEL_ID,
            "usage": {"prompt_tokens": token_count, "total_tokens": token_count},
        }

    return app


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    uvicorn.run(create_app(args.device), host=args.host, port=args.port)


if __name__ == "__main__":
    main()