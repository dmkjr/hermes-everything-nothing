"""Pending suggestions, shared by the two halves of the plugin.

The hook that writes a suggestion (``__init__.py``) and the route that serves
it to Desktop (``dashboard/plugin_api.py``) can run in different processes:
a gateway serving several profiles runs a secondary profile's dashboard
plugin API in that profile's plugin host, while that profile's turns (and so
its hooks) run in the gateway. Memory is not shared between them, so this
SQLite file in the plugin's data directory is the only state both halves
read and write. WAL lets one process read while the other writes.

One row per session: the pending suggestion, or the reason the last one
could not be generated. Both halves load this file by path (the host imports
``plugin_api.py`` with no package), so it holds no state of its own.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

PLUGIN_NAME = "everything-nothing"
DB_FILE = "suggestions.db"
SUGGESTION_TTL_SECONDS = 7 * 24 * 3600
# A failure note only explains the latest turn; after a restart (often the
# fix) an old one would just be noise.
FAILURE_TTL_SECONDS = 6 * 3600
MAX_ROWS = 200

_SCHEMA = """
CREATE TABLE IF NOT EXISTS pending (
    session_id TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    text       TEXT,
    failure    TEXT,
    timestamp  REAL NOT NULL,
    alternatives TEXT
)
"""


def data_dir() -> Optional[Path]:
    """``<hermes home>/plugin-data/next-prompt/`` of the profile in scope now.

    Resolved on every call: the request or turn decides the profile.
    """
    try:
        from plugins.plugin_storage import plugin_data_dir
    except ImportError:  # hosts before the plugin storage helpers
        plugin_data_dir = None
    try:
        if plugin_data_dir is not None:
            return plugin_data_dir(PLUGIN_NAME)
        try:
            from hermes_constants import get_hermes_home
            home = get_hermes_home()
        except Exception:
            # Bare hosts/tests: fall back to the HERMES_HOME env var.
            env_home = os.environ.get("HERMES_HOME")
            if not env_home:
                raise
            home = Path(env_home)
        path = home / "plugin-data" / PLUGIN_NAME
        path.mkdir(parents=True, exist_ok=True)
        return path
    except Exception as exc:
        logger.warning("everything-nothing: no data directory: %s", exc)
        return None


def _connect() -> Optional[sqlite3.Connection]:
    try:
        from plugins.plugin_storage import plugin_db
    except ImportError:
        plugin_db = None
    try:
        if plugin_db is not None:
            conn = plugin_db(PLUGIN_NAME, DB_FILE)
        else:
            directory = data_dir()
            if directory is None:
                return None
            conn = sqlite3.connect(str(directory / DB_FILE), timeout=5.0, check_same_thread=False)
            conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(_SCHEMA)
        if "alternatives" not in {row[1] for row in conn.execute("PRAGMA table_info(pending)")}:
            with conn:
                conn.execute("BEGIN IMMEDIATE")
                if "alternatives" not in {row[1] for row in conn.execute("PRAGMA table_info(pending)")}:
                    conn.execute("ALTER TABLE pending ADD COLUMN alternatives TEXT")
        return conn
    except Exception as exc:
        logger.warning("everything-nothing: could not open %s: %s", DB_FILE, exc)
        return None


def _write(session_id: str, kind: str, text: Optional[str], failure: Optional[str],
           alternatives: Optional[str] = None) -> Optional[float]:
    conn = _connect()
    if conn is None:
        return None
    now = time.time()
    try:
        with closing(conn), conn:
            conn.execute(
                "INSERT OR REPLACE INTO pending (session_id, kind, text, failure, timestamp, alternatives) VALUES (?, ?, ?, ?, ?, ?)",
                (session_id, kind, text, failure, now, alternatives),
            )
            conn.execute(
                "DELETE FROM pending WHERE (kind = 'suggestion' AND timestamp < ?) OR (kind != 'suggestion' AND timestamp < ?)",
                (now - SUGGESTION_TTL_SECONDS, now - FAILURE_TTL_SECONDS),
            )
            conn.execute(
                "DELETE FROM pending WHERE session_id NOT IN "
                "(SELECT session_id FROM pending ORDER BY timestamp DESC LIMIT ?)",
                (MAX_ROWS,),
            )
    except sqlite3.Error as exc:
        logger.warning("everything-nothing: could not save the %s for %s: %s", kind, session_id, exc)
        return None
    return now


def put_suggestion(session_id: str, text: str, alternatives: Optional[list[str]] = None) -> Optional[Dict[str, Any]]:
    """Store the session's pending suggestion, replacing whatever it had."""
    timestamp = _write(session_id, "suggestion", text, None, json.dumps(alternatives) if alternatives is not None else None)
    if timestamp is None:
        return None
    return {"text": text, "session_id": session_id, "timestamp": timestamp}


def put_failure(session_id: str, kind: str) -> None:
    """Record why this turn has no suggestion (a coarse kind, never error text)."""
    _write(session_id, "failure", None, kind)


def clear(session_id: str) -> None:
    """Drop the session's suggestion or failure note (used, dismissed, superseded)."""
    conn = _connect()
    if conn is None:
        return
    try:
        with closing(conn), conn:
            conn.execute("DELETE FROM pending WHERE session_id = ?", (session_id,))
    except sqlite3.Error as exc:
        logger.warning("everything-nothing: could not clear %s: %s", session_id, exc)


def get(session_id: str) -> Dict[str, Optional[Dict[str, Any]]]:
    """``{"suggestion": …, "error": …}`` for one session, the REST payload."""
    empty: Dict[str, Optional[Dict[str, Any]]] = {"suggestion": None, "error": None}
    if not session_id:
        return empty
    conn = _connect()
    if conn is None:
        return empty
    try:
        with closing(conn):
            row = conn.execute(
                "SELECT kind, text, failure, timestamp, alternatives FROM pending WHERE session_id = ?", (session_id,)
            ).fetchone()
    except sqlite3.Error as exc:
        logger.warning("everything-nothing: could not read %s: %s", session_id, exc)
        return empty
    if not row:
        return empty
    kind, text, failure, timestamp, alternatives = row
    age = time.time() - float(timestamp or 0)
    if kind == "suggestion" and text and age < SUGGESTION_TTL_SECONDS:
        suggestion = {"text": text, "session_id": session_id, "timestamp": timestamp}
        if alternatives is not None:
            suggestion["alternatives"] = json.loads(alternatives)
        return {"suggestion": suggestion, "error": None}
    if kind == "failure" and failure and age < FAILURE_TTL_SECONDS:
        return {"suggestion": None, "error": {"kind": failure, "session_id": session_id, "timestamp": timestamp}}
    return empty


def count() -> int:
    """Pending suggestions in the store (for the registration log line)."""
    conn = _connect()
    if conn is None:
        return 0
    try:
        with closing(conn):
            row = conn.execute(
                "SELECT COUNT(*) FROM pending WHERE kind = 'suggestion' AND timestamp >= ?",
                (time.time() - SUGGESTION_TTL_SECONDS,),
            ).fetchone()
    except sqlite3.Error:
        return 0
    return int(row[0]) if row else 0


def import_legacy(entries: Dict[str, Any]) -> int:
    """Carry pending suggestions over from the 0.3.0 ``suggestions.json``.

    Only sessions with no row yet; keeps each entry's original timestamp.
    """
    conn = _connect()
    if conn is None:
        return 0
    now = time.time()
    rows = [
        (sid, entry["text"], float(entry.get("timestamp") or 0))
        for sid, entry in entries.items()
        if isinstance(entry, dict) and entry.get("text")
        and now - float(entry.get("timestamp") or 0) < SUGGESTION_TTL_SECONDS
    ]
    try:
        with closing(conn), conn:
            before = conn.total_changes
            conn.executemany(
                "INSERT OR IGNORE INTO pending (session_id, kind, text, failure, timestamp) "
                "VALUES (?, 'suggestion', ?, NULL, ?)",
                rows,
            )
            return conn.total_changes - before
    except sqlite3.Error as exc:
        logger.warning("everything-nothing: could not import saved suggestions: %s", exc)
        return 0


_COMPACTION_SCHEMA = """CREATE TABLE IF NOT EXISTS compaction_totals (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    runs INTEGER NOT NULL,
    measured INTEGER NOT NULL,
    reclaimed INTEGER NOT NULL,
    proactive INTEGER NOT NULL
)"""


def record_compaction(reclaimed: Optional[int], *, proactive: bool) -> None:
    conn = _connect()
    if conn is None:
        return
    try:
        with closing(conn), conn:
            conn.execute(_COMPACTION_SCHEMA)
            conn.execute(
                """INSERT INTO compaction_totals VALUES (1, 1, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    runs = runs + 1, measured = measured + excluded.measured,
                    reclaimed = reclaimed + excluded.reclaimed,
                    proactive = proactive + excluded.proactive""",
                (int(reclaimed is not None), reclaimed or 0, int(proactive)),
            )
    except sqlite3.Error:
        logger.debug("everything-nothing: compaction metrics could not be saved", exc_info=True)


def compaction_totals() -> Dict[str, int]:
    conn = _connect()
    if conn is None:
        return {}
    with closing(conn):
        conn.execute(_COMPACTION_SCHEMA)
        row = conn.execute("SELECT runs, measured, reclaimed, proactive FROM compaction_totals WHERE id = 1").fetchone()
    return dict(zip(("runs", "measured", "reclaimed", "proactive"), row or (0, 0, 0, 0)))
