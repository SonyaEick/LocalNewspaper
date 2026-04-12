from __future__ import annotations

import json
import os
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, Security, WebSocket, WebSocketDisconnect, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import APIKeyHeader
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
_data_dir_env = os.environ.get("NEWSPAPER_DATA_DIR", "").strip()
if _data_dir_env:
    _data_root = Path(_data_dir_env)
    _data_root.mkdir(parents=True, exist_ok=True)
    DB_PATH = _data_root / "newspaper.db"
    UPLOAD_DIR = _data_root / "uploads"
else:
    DB_PATH = BASE_DIR / "newspaper.db"
    UPLOAD_DIR = BASE_DIR / "uploads"
MAX_VISIBLE_STORIES = 15

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        dead_connections: list[WebSocket] = []
        for connection in self.active_connections:
            try:
                await connection.send_text(json.dumps(payload))
            except Exception:
                dead_connections.append(connection)
        for connection in dead_connections:
            self.disconnect(connection)


manager = ConnectionManager()
app = FastAPI(title="Local Newspaper API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with closing(get_connection()) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS stories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                author_name TEXT NOT NULL,
                headline TEXT NOT NULL,
                summary_sentence TEXT NOT NULL,
                main_story TEXT NOT NULL,
                image_url TEXT,
                image_upload_path TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS reactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                story_id INTEGER NOT NULL,
                reaction_type TEXT NOT NULL,
                count INTEGER NOT NULL DEFAULT 0,
                UNIQUE(story_id, reaction_type),
                FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE
            )
            """
        )
        conn.commit()


def normalize_story(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "author_name": row["author_name"],
        "headline": row["headline"],
        "summary_sentence": row["summary_sentence"],
        "main_story": row["main_story"],
        "image_url": row["image_url"],
        "image_upload_url": f"/uploads/{row['image_upload_path']}" if row["image_upload_path"] else None,
        "created_at": row["created_at"],
    }


class StoryUpdate(BaseModel):
    """Send only fields you want to change. Omitted fields stay as-is."""

    author_name: str | None = Field(None, description="Byline / display name")
    headline: str | None = Field(None, description="Story headline")
    summary_sentence: str | None = Field(None, description="One-line summary (brief slots)")
    main_story: str | None = Field(None, description="Full story body")
    image_url: str | None = Field(None, description="External image URL; empty string clears it")
    remove_uploaded_image: bool | None = Field(
        None, description="If true, clears the uploaded file reference (keeps image_url if set)"
    )


edit_token_header = APIKeyHeader(name="X-Edit-Token", auto_error=False)


def require_edit_token(x_edit_token: str | None = Security(edit_token_header)) -> None:
    expected = os.environ.get("NEWSPAPER_EDIT_TOKEN", "").strip()
    if not expected:
        return
    if not x_edit_token or x_edit_token != expected:
        raise HTTPException(status_code=403, detail="Invalid or missing X-Edit-Token header.")


def get_reaction_map(conn: sqlite3.Connection, story_ids: list[int]) -> dict[int, dict[str, int]]:
    if not story_ids:
        return {}

    placeholders = ",".join("?" for _ in story_ids)
    rows = conn.execute(
        f"SELECT story_id, reaction_type, count FROM reactions WHERE story_id IN ({placeholders})",
        story_ids,
    ).fetchall()
    reaction_map: dict[int, dict[str, int]] = {story_id: {} for story_id in story_ids}
    for row in rows:
        reaction_map[row["story_id"]][row["reaction_type"]] = row["count"]
    return reaction_map


@app.on_event("startup")
def on_startup() -> None:
    init_db()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/db")
def health_db() -> dict[str, Any]:
    """Sanity check for deployments: confirms SQLite file is readable/writable."""
    try:
        with closing(get_connection()) as conn:
            conn.execute("SELECT 1")
        return {"ok": True, "db_path": str(DB_PATH)}
    except Exception as exc:
        return {"ok": False, "db_path": str(DB_PATH), "error": str(exc)}


@app.get("/stories/visible")
def get_visible_stories() -> dict[str, Any]:
    with closing(get_connection()) as conn:
        rows = conn.execute(
            """
            SELECT * FROM stories
            ORDER BY id DESC
            LIMIT ?
            """,
            (MAX_VISIBLE_STORIES,),
        ).fetchall()

        stories = [normalize_story(row) for row in rows]
        reaction_map = get_reaction_map(conn, [story["id"] for story in stories])
        for story in stories:
            story["reactions"] = reaction_map.get(story["id"], {})

        return {"stories": stories, "max_visible_stories": MAX_VISIBLE_STORIES}


@app.get("/stories/all")
def get_all_stories() -> dict[str, Any]:
    with closing(get_connection()) as conn:
        rows = conn.execute("SELECT * FROM stories ORDER BY id DESC").fetchall()
        stories = [normalize_story(row) for row in rows]
        return {"stories": stories}


@app.post("/stories/add")
async def add_story(
    author_name: str = Form(...),
    headline: str = Form(...),
    summary_sentence: str = Form(...),
    main_story: str = Form(...),
    image_url: str | None = Form(None),
    image_upload: UploadFile | None = File(None),
) -> JSONResponse:
    clean_author = author_name.strip()
    clean_headline = headline.strip()
    clean_summary = summary_sentence.strip()
    clean_main_story = main_story.strip()
    clean_image_url = image_url.strip() if image_url else None

    if not clean_author or not clean_headline or not clean_summary or not clean_main_story:
        return JSONResponse(
            status_code=400,
            content={"detail": "Author, headline, summary, and story body are required."},
        )

    upload_path = None
    if image_upload and image_upload.filename:
        extension = Path(image_upload.filename).suffix
        upload_filename = f"{uuid4().hex}{extension}"
        upload_target = UPLOAD_DIR / upload_filename
        content = await image_upload.read()
        upload_target.write_bytes(content)
        upload_path = upload_filename

    created_at = datetime.now(timezone.utc).isoformat()
    with closing(get_connection()) as conn:
        cursor = conn.execute(
            """
            INSERT INTO stories (author_name, headline, summary_sentence, main_story, image_url, image_upload_path, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                clean_author,
                clean_headline,
                clean_summary,
                clean_main_story,
                clean_image_url,
                upload_path,
                created_at,
            ),
        )
        story_id = cursor.lastrowid
        conn.commit()

        row = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
        story = normalize_story(row)
        story["reactions"] = {}

    await manager.broadcast({"type": "story_added", "story_id": story_id})
    return JSONResponse(content={"story": story})


@app.patch(
    "/stories/{story_id}",
    tags=["stories"],
    summary="Edit a story (Swagger /docs)",
    description=(
        "Typo fixes without SQL. If env `NEWSPAPER_EDIT_TOKEN` is set on the server, click **Authorize** "
        "and enter the same value for `X-Edit-Token`. If unset, no token is required (dev only)."
    ),
)
async def update_story(
    story_id: int,
    body: StoryUpdate,
    _token: None = Depends(require_edit_token),
) -> JSONResponse:
    payload = body.model_dump(exclude_unset=True)
    remove_upload = payload.pop("remove_uploaded_image", None)

    set_parts: list[str] = []
    values: list[Any] = []

    text_fields = ("author_name", "headline", "summary_sentence", "main_story")
    for key in text_fields:
        if key not in payload:
            continue
        val = payload[key]
        if val is None:
            continue
        if isinstance(val, str) and not val.strip():
            return JSONResponse(
                status_code=400,
                content={"detail": f"{key} cannot be empty (omit the field to leave unchanged)."},
            )
        set_parts.append(f"{key} = ?")
        values.append(val.strip() if isinstance(val, str) else val)

    if "image_url" in payload:
        raw = payload["image_url"]
        if raw is None:
            set_parts.append("image_url = ?")
            values.append(None)
        else:
            cleaned = raw.strip() if isinstance(raw, str) else None
            set_parts.append("image_url = ?")
            values.append(cleaned or None)

    if remove_upload is True:
        set_parts.append("image_upload_path = ?")
        values.append(None)

    if not set_parts:
        return JSONResponse(
            status_code=400,
            content={"detail": "No fields to update. Send at least one property in the JSON body."},
        )

    values.append(story_id)
    sql = f"UPDATE stories SET {', '.join(set_parts)} WHERE id = ?"

    with closing(get_connection()) as conn:
        cur = conn.execute(sql, values)
        if cur.rowcount == 0:
            return JSONResponse(status_code=404, content={"detail": "Story not found."})
        conn.commit()
        row = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
        story = normalize_story(row)
        reaction_map = get_reaction_map(conn, [story_id])
        story["reactions"] = reaction_map.get(story_id, {})

    await manager.broadcast({"type": "story_updated", "story_id": story_id})
    return JSONResponse(content={"story": story})


@app.delete(
    "/stories/{story_id}",
    tags=["stories"],
    summary="Delete a story (Swagger /docs)",
    description=(
        "Removes the story, its reactions, and the uploaded image file if any. "
        "Same `X-Edit-Token` rules as PATCH when `NEWSPAPER_EDIT_TOKEN` is set."
    ),
)
async def delete_story(
    story_id: int,
    _token: None = Depends(require_edit_token),
) -> JSONResponse:
    with closing(get_connection()) as conn:
        row = conn.execute(
            "SELECT image_upload_path FROM stories WHERE id = ?",
            (story_id,),
        ).fetchone()
        if not row:
            return JSONResponse(status_code=404, content={"detail": "Story not found."})
        upload_name = row["image_upload_path"]
        conn.execute("DELETE FROM reactions WHERE story_id = ?", (story_id,))
        conn.execute("DELETE FROM stories WHERE id = ?", (story_id,))
        conn.commit()

    if upload_name:
        try:
            path = UPLOAD_DIR / upload_name
            if path.is_file():
                path.unlink()
        except OSError:
            pass

    await manager.broadcast({"type": "story_deleted", "story_id": story_id})
    return JSONResponse(content={"ok": True, "deleted_id": story_id})


@app.post("/stories/{story_id}/react")
async def react_to_story(story_id: int, reaction_type: str = Form(...)) -> JSONResponse:
    allowed_reactions = {"like", "love", "wow", "laugh"}
    if reaction_type not in allowed_reactions:
        return JSONResponse(status_code=400, content={"detail": "Invalid reaction type."})

    with closing(get_connection()) as conn:
        story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
        if not story:
            return JSONResponse(status_code=404, content={"detail": "Story not found."})

        conn.execute(
            """
            INSERT INTO reactions (story_id, reaction_type, count)
            VALUES (?, ?, 1)
            ON CONFLICT(story_id, reaction_type)
            DO UPDATE SET count = count + 1
            """,
            (story_id, reaction_type),
        )
        conn.commit()
        reaction_row = conn.execute(
            "SELECT count FROM reactions WHERE story_id = ? AND reaction_type = ?",
            (story_id, reaction_type),
        ).fetchone()
        count = reaction_row["count"] if reaction_row else 0

    await manager.broadcast(
        {
            "type": "reaction_updated",
            "story_id": story_id,
            "reaction_type": reaction_type,
            "count": count,
        }
    )
    return JSONResponse(content={"story_id": story_id, "reaction_type": reaction_type, "count": count})


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)
