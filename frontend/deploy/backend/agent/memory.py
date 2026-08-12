"""
WorkBuddy Memory System — 三层记忆架构

Layer 1 — Cloud Memory (云端): 自动学习的用户画像 + 历史对话检索
Layer 2 — User Local Memory (用户本地): 跨项目精确规则 ~/.workbuddy/MEMORY.md
Layer 3 — Workspace Memory (工作区): 每日日志 + 项目长期笔记
"""
from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional


# ============================================================
# Data Models
# ============================================================

@dataclass
class MemoryEntry:
    """A single memory entry."""
    content: str
    source: str  # "cloud" | "user" | "workspace"
    timestamp: str
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class MemoryContext:
    """Aggregated memory context for injection into prompts."""
    cloud_profile: Optional[str] = None
    user_rules: Optional[str] = None
    workspace_notes: Optional[str] = None
    recent_logs: List[str] = field(default_factory=list)

    def to_prompt_text(self) -> str:
        parts = []
        if self.cloud_profile:
            parts.append(f"<user_profile>\n{self.cloud_profile}\n</user_profile>")
        if self.user_rules:
            parts.append(f"<user_rules>\n{self.user_rules}\n</user_rules>")
        if self.workspace_notes:
            parts.append(f"<project_context>\n{self.workspace_notes}\n</project_context>")
        if self.recent_logs:
            logs_text = "\n".join(self.recent_logs[-5:])
            parts.append(f"<recent_work>\n{logs_text}\n</recent_work>")
        return "\n\n".join(parts) if parts else ""


# ============================================================
# Layer 1: Cloud Memory (simulated — would be a server DB)
# ============================================================

class CloudMemoryStore:
    """
    Layer 1 — Cloud Memory.

    In production: server-side database with:
    - User profile auto-learned from conversations
    - Historical conversation embeddings for semantic search
    - Server-managed, read-only from agent perspective
    """

    def __init__(self, db_path: str = "~/.workbuddy/memory/cloud/cloud.db"):
        self.db_path = os.path.expanduser(db_path)
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS profile (
                    id INTEGER PRIMARY KEY,
                    content TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    summary TEXT,
                    tags TEXT,
                    created_at TEXT NOT NULL,
                    embedding BLOB
                )
            """)
            conn.commit()

    def get_profile(self) -> Optional[str]:
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute(
                "SELECT content FROM profile ORDER BY updated_at DESC LIMIT 1"
            ).fetchone()
        return row[0] if row else None

    def update_profile(self, content: str):
        now = datetime.now().isoformat()
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("DELETE FROM profile")
            conn.execute(
                "INSERT INTO profile (content, updated_at) VALUES (?, ?)",
                (content, now),
            )
            conn.commit()

    def search_conversations(self, query: str, limit: int = 5) -> List[Dict]:
        """Simple keyword search — in production: semantic/embedding search."""
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT id, summary, tags, created_at FROM conversations "
                "WHERE summary LIKE ? OR tags LIKE ? "
                "ORDER BY created_at DESC LIMIT ?",
                (f"%{query}%", f"%{query}%", limit),
            ).fetchall()

        return [
            {"id": r[0], "summary": r[1], "tags": r[2], "created_at": r[3]}
            for r in rows
        ]


# ============================================================
# Layer 2: User Local Memory
# ============================================================

class UserLocalMemory:
    """
    Layer 2 — User-level Local Memory.

    File: ~/.workbuddy/MEMORY.md
    - Cross-project preferences and rules
    - Manually curated by the user and agent
    - Max 4000 chars per session write
    """

    def __init__(self, file_path: str = "~/.workbuddy/MEMORY.md"):
        self.file_path = os.path.expanduser(file_path)
        self._max_session_chars = 4000

    def read(self) -> Optional[str]:
        """Read the user memory file."""
        try:
            return Path(self.file_path).read_text(encoding="utf-8")
        except FileNotFoundError:
            return None

    def write(self, content: str):
        """Write to the user memory file."""
        os.makedirs(os.path.dirname(self.file_path), exist_ok=True)
        Path(self.file_path).write_text(content, encoding="utf-8")

    def append(self, content: str):
        """Append to the user memory file (within session limit)."""
        existing = self.read() or ""
        # Enforce session character limit
        new_content = existing + "\n" + content
        if len(new_content) - len(existing) > self._max_session_chars:
            print("[UserMemory] Session write limit reached, truncating.")
            new_content = existing + "\n" + content[:self._max_session_chars]
        self.write(new_content)


# ============================================================
# Layer 3: Workspace Memory
# ============================================================

class WorkspaceMemory:
    """
    Layer 3 — Workspace Memory.

    Directory: .workbuddy/memory/
    - YYYY-MM-DD.md: daily work logs (append-only)
    - MEMORY.md: curated long-term project notes (max 3000 chars/session)
    """

    def __init__(self, workspace_root: str = "."):
        self.memory_dir = Path(workspace_root) / ".workbuddy" / "memory"
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        self._max_session_chars = 3000

    def get_daily_log_path(self, date: Optional[datetime] = None) -> Path:
        d = date or datetime.now()
        return self.memory_dir / f"{d.strftime('%Y-%m-%d')}.md"

    def log(self, content: str):
        """Append to today's daily log (append-only)."""
        log_path = self.get_daily_log_path()
        timestamp = datetime.now().strftime("%H:%M")
        entry = f"\n## {timestamp}\n{content}\n"
        if log_path.exists():
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(entry)
        else:
            log_path.write_text(f"# {datetime.now().strftime('%Y-%m-%d')}\n{entry}", encoding="utf-8")

    def get_recent_logs(self, days: int = 7) -> List[str]:
        """Read recent daily logs."""
        logs = []
        for i in range(days):
            d = datetime.now() - timedelta(days=i)
            log_path = self.get_daily_log_path(d)
            if log_path.exists():
                content = log_path.read_text(encoding="utf-8")
                logs.append(f"### {d.strftime('%Y-%m-%d')}\n{content[:2000]}")
        return logs

    def get_project_notes(self) -> Optional[str]:
        """Read long-term project notes."""
        notes_path = self.memory_dir / "MEMORY.md"
        try:
            return notes_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None

    def update_project_notes(self, content: str):
        """Update project notes (enforce session limit)."""
        notes_path = self.memory_dir / "MEMORY.md"
        existing = ""
        if notes_path.exists():
            existing = notes_path.read_text(encoding="utf-8")

        # Enforce session write limit
        new_content = existing + "\n" + content
        if len(new_content) - len(existing) > self._max_session_chars:
            new_content = existing + "\n" + content[:self._max_session_chars]

        notes_path.write_text(new_content, encoding="utf-8")

    def auto_clean(self, max_age_days: int = 30):
        """Remove daily logs older than max_age_days, distill into MEMORY.md."""
        cutoff = datetime.now() - timedelta(days=max_age_days)
        for log_file in self.memory_dir.glob("????-??-??.md"):
            try:
                date_str = log_file.stem
                log_date = datetime.strptime(date_str, "%Y-%m-%d")
                if log_date < cutoff:
                    # Would distill into MEMORY.md in production
                    log_file.unlink()
                    print(f"[WorkspaceMemory] Cleaned old log: {log_file.name}")
            except (ValueError, OSError):
                pass


# ============================================================
# Memory Manager — orchestrates all 3 layers
# ============================================================

class MemoryManager:
    """
    Central memory manager.

    The Agent Loop calls `get_context()` before each turn to inject
    relevant memory into the system prompt.
    """

    def __init__(
        self,
        workspace_root: str = ".",
        cloud_db_path: str = "~/.workbuddy/memory/cloud/cloud.db",
        user_memory_path: str = "~/.workbuddy/MEMORY.md",
    ):
        self.cloud = CloudMemoryStore(cloud_db_path)
        self.user = UserLocalMemory(user_memory_path)
        self.workspace = WorkspaceMemory(workspace_root)

    def get_context(self) -> MemoryContext:
        """Aggregate all memory layers for prompt injection."""
        return MemoryContext(
            cloud_profile=self.cloud.get_profile(),
            user_rules=self.user.read(),
            workspace_notes=self.workspace.get_project_notes(),
            recent_logs=self.workspace.get_recent_logs(days=7),
        )

    def log_work(self, content: str):
        """Log to daily file after substantive work."""
        self.workspace.log(content)

    def search_past_conversations(self, query: str) -> List[Dict]:
        """Search cloud memory for past conversations."""
        return self.cloud.search_conversations(query)

    def save_project_note(self, content: str):
        """Save to project MEMORY.md."""
        self.workspace.update_project_notes(content)

    def save_user_rule(self, content: str):
        """Save to user MEMORY.md."""
        self.user.append(content)
