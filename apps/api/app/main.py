from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from app.config import get_settings

from app.routers import blueprints, content, corpus, health, jobs, practice, practice_analysis, references, speaking

app = FastAPI(
    title="Libitu API",
    version="0.1.0",
    summary="Backend API for Libitu's input, corpus, and speaking practice loops.",
)

# Word metadata is repetitive JSON. Starlette excludes text/event-stream, so
# confirmed subtitle previews keep streaming instead of waiting for gzip buffers.
app.add_middleware(GZipMiddleware, minimum_size=2048, compresslevel=3)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().authorized_parties,
    allow_origin_regex=r"^chrome-extension://.*$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(practice.router)
app.include_router(practice_analysis.router)
app.include_router(references.router)
app.include_router(content.router, prefix="/api/content", tags=["content"])
app.include_router(jobs.router, prefix="/api/jobs", tags=["jobs"])
app.include_router(blueprints.router, prefix="/api/blueprints", tags=["blueprints"])
app.include_router(corpus.router, prefix="/api/corpus", tags=["corpus"])
app.include_router(speaking.router, prefix="/api/speaking", tags=["speaking"])
