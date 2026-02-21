from fastapi import FastAPI
from pydantic import BaseModel
from typing import List, Dict, Any

from .inference import infer_kinship

app = FastAPI(title="KinNet API")


class CalculateRequest(BaseModel):
    nodes: List[Dict[str, Any]]
    edges: List[Dict[str, Any]]
    sourceId: str
    targetId: str


class CalculateResponse(BaseModel):
    title: str
    aliases: List[str] = []
    chain: str = ""
    match_type: str = ""
    path_desc: str = ""


@app.post("/api/calculate", response_model=CalculateResponse)
def calculate_relationship(req: CalculateRequest):
    result = infer_kinship(req.sourceId, req.targetId, req.nodes, req.edges)
    return CalculateResponse(**result)


@app.get("/api/health")
def health_check():
    return {"status": "ok"}
