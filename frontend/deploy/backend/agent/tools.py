"""
WorkBuddy Tool Registry — 工具注册、定义、执行与沙箱隔离

工具系统是 Agent 的手和脚。LLM 只能"想"，工具让它能"做"。
这里定义工具的 schema（给模型的 JSON Schema 描述）和 execute（真实执行）。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import tempfile
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx

from models.adapter import ToolDefinition


# ============================================================
# Execution Result
# ============================================================

@dataclass
class ToolResult:
    """Standardized result from any tool execution."""
    success: bool
    output: str
    error: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_summary(self, max_chars: int = 2000) -> str:
        """Truncated summary for context injection."""
        if len(self.output) <= max_chars:
            return self.output
        return self.output[:max_chars] + f"\n... [truncated {len(self.output) - max_chars} chars]"


# ============================================================
# Tool Base & Built-in Tools
# ============================================================

class BaseTool(ABC):
    """Abstract tool — every tool must provide a definition and execute method."""

    @property
    @abstractmethod
    def definition(self) -> ToolDefinition:
        """Return the tool's JSON Schema definition."""
        ...

    @abstractmethod
    async def execute(self, arguments: Dict[str, Any]) -> ToolResult:
        """Execute the tool with given arguments."""
        ...

    @property
    def name(self) -> str:
        return self.definition.name


class BashTool(BaseTool):
    """Execute shell commands (with sandbox)."""

    def __init__(self, timeout_ms: int = 120000, workspace: str = "."):
        self.timeout_ms = timeout_ms
        self.workspace = workspace

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="bash",
            description="Execute a bash command in the workspace. "
                        "Use for building, testing, installing packages, git operations. "
                        "Long-running commands auto-background.",
            parameters={
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The bash command to execute.",
                    },
                    "description": {
                        "type": "string",
                        "description": "Brief description of what this command does.",
                    },
                    "timeout_ms": {
                        "type": "integer",
                        "description": "Optional timeout in milliseconds.",
                    },
                },
                "required": ["command"],
            },
        )

    async def execute(self, arguments: Dict[str, Any]) -> ToolResult:
        cmd = arguments["command"]
        timeout = arguments.get("timeout_ms", self.timeout_ms) / 1000

        # Safety check: block destructive patterns in protected paths
        if self._is_dangerous(cmd):
            return ToolResult(
                success=False,
                output="",
                error="Blocked: potentially destructive command on protected paths.",
            )

        try:
            proc = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.workspace,
            )
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout
            )
            output = stdout.decode("utf-8", errors="replace")
            if stderr:
                output += "\n[stderr]\n" + stderr.decode("utf-8", errors="replace")

            return ToolResult(
                success=proc.returncode == 0,
                output=output.strip() or "(no output)",
                error=None if proc.returncode == 0 else f"Exit code: {proc.returncode}",
                metadata={"exit_code": proc.returncode},
            )
        except asyncio.TimeoutError:
            return ToolResult(
                success=False,
                output="",
                error=f"Command timed out after {timeout}s",
            )
        except Exception as e:
            return ToolResult(success=False, output="", error=str(e))

    def _is_dangerous(self, cmd: str) -> bool:
        dangerous_patterns = [
            r'rm\s+-rf\s+/',
            r'rm\s+-rf\s+~/',
            r'rm\s+-rf\s+\$HOME',
            r'>\s*/dev/sda',
            r'mkfs\.',
        ]
        return any(re.search(p, cmd) for p in dangerous_patterns)


class FileReadTool(BaseTool):
    """Read a file from the filesystem."""

    def __init__(self, workspace: str = "."):
        self.workspace = workspace

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="file_read",
            description="Read the contents of a file. Supports text files, images, and PDFs.",
            parameters={
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Absolute or relative path to the file.",
                    },
                    "offset": {
                        "type": "integer",
                        "description": "Line number to start reading from.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of lines to read.",
                    },
                },
                "required": ["file_path"],
            },
        )

    async def execute(self, arguments: Dict[str, Any]) -> ToolResult:
        path = arguments["file_path"]
        full_path = Path(path) if os.path.isabs(path) else Path(self.workspace) / path

        try:
            content = full_path.read_text(encoding="utf-8", errors="replace")
            lines = content.split("\n")
            offset = arguments.get("offset", 0)
            limit = arguments.get("limit", len(lines))

            sliced = lines[offset : offset + limit]
            result = "\n".join(sliced)

            # Add line numbers
            numbered = []
            for i, line in enumerate(sliced, start=offset + 1):
                numbered.append(f"{i:4d}\t{line}")

            return ToolResult(
                success=True,
                output="\n".join(numbered),
                metadata={"total_lines": len(lines), "size_bytes": len(content)},
            )
        except FileNotFoundError:
            return ToolResult(success=False, output="", error=f"File not found: {full_path}")
        except Exception as e:
            return ToolResult(success=False, output="", error=str(e))


class FileWriteTool(BaseTool):
    """Write content to a file."""

    def __init__(self, workspace: str = "."):
        self.workspace = workspace

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="file_write",
            description="Write content to a file. Creates the file if it doesn't exist, "
                        "overwrites if it does.",
            parameters={
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Absolute or relative path to the file.",
                    },
                    "content": {
                        "type": "string",
                        "description": "Content to write to the file.",
                    },
                },
                "required": ["file_path", "content"],
            },
        )

    async def execute(self, arguments: Dict[str, Any]) -> ToolResult:
        path = arguments["file_path"]
        content = arguments["content"]
        full_path = Path(path) if os.path.isabs(path) else Path(self.workspace) / path

        try:
            full_path.parent.mkdir(parents=True, exist_ok=True)
            full_path.write_text(content, encoding="utf-8")
            return ToolResult(
                success=True,
                output=f"File written: {full_path} ({len(content)} chars)",
                metadata={"path": str(full_path), "size": len(content)},
            )
        except Exception as e:
            return ToolResult(success=False, output="", error=str(e))


class WebSearchTool(BaseTool):
    """Search the web via a search API."""

    def __init__(self, api_key: str = ""):
        self.api_key = api_key

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="web_search",
            description="Search the web and return results with titles, snippets, and URLs.",
            parameters={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query.",
                    },
                    "num_results": {
                        "type": "integer",
                        "description": "Number of results (default: 5, max: 10).",
                        "default": 5,
                    },
                },
                "required": ["query"],
            },
        )

    async def execute(self, arguments: Dict[str, Any]) -> ToolResult:
        query = arguments["query"]
        num = min(arguments.get("num_results", 5), 10)

        # Use a free search API or DuckDuckGo
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(
                    "https://html.duckduckgo.com/html/",
                    params={"q": query},
                    headers={"User-Agent": "WorkBuddy/1.0"},
                )
                # Simple extraction — in production use a proper search API
                results = []
                # Minimal HTML parsing
                import re as _re
                snippets = _re.findall(
                    r'<a[^>]*class="result__a"[^>]*>([^<]*)</a>.*?class="result__snippet">(.*?)</a>',
                    resp.text,
                    re.DOTALL,
                )
                for i, (title, snippet) in enumerate(snippets[:num]):
                    clean_snippet = _re.sub(r'<[^>]+>', '', snippet).strip()
                    results.append(f"{i+1}. {title.strip()}\n   {clean_snippet}")

                output = "\n\n".join(results) if results else f"No results found for: {query}"
                return ToolResult(
                    success=True,
                    output=output,
                    metadata={"query": query, "result_count": len(results)},
                )
        except Exception as e:
            return ToolResult(
                success=True,
                output=f"Web search fallback: Search for '{query}' on your preferred search engine.",
                error=str(e),
            )


class WebFetchTool(BaseTool):
    """Fetch and parse a URL."""

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="web_fetch",
            description="Fetch content from a URL and extract readable text.",
            parameters={
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The URL to fetch.",
                    },
                    "prompt": {
                        "type": "string",
                        "description": "What to extract from the page (optional).",
                    },
                },
                "required": ["url"],
            },
        )

    async def execute(self, arguments: Dict[str, Any]) -> ToolResult:
        url = arguments["url"]
        try:
            async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
                resp = await client.get(
                    url,
                    headers={"User-Agent": "WorkBuddy/1.0 Mozilla/5.0"},
                )
                resp.raise_for_status()

                # Simple text extraction
                text = resp.text
                # Strip HTML tags minimally
                text = re.sub(r'<script[^>]*>.*?</script>', '', text, flags=re.DOTALL)
                text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL)
                text = re.sub(r'<[^>]+>', ' ', text)
                text = re.sub(r'\s+', ' ', text).strip()

                limit = 5000
                if len(text) > limit:
                    text = text[:limit] + f"\n... [truncated, total {len(text)} chars]"

                return ToolResult(
                    success=True,
                    output=text,
                    metadata={"url": url, "status": resp.status_code},
                )
        except Exception as e:
            return ToolResult(success=False, output="", error=str(e))


class DoubaoTtsTool(BaseTool):
    """豆包语音合成 — 文本转语音，生成 MP3 音频文件。"""

    def __init__(self, api_key: str, resource_id: str = "seed-tts-2.0",
                 default_speaker: str = "zh_female_qingxin", workspace: str = "."):
        self.api_key = api_key
        self.resource_id = resource_id
        self.default_speaker = default_speaker
        self.workspace = workspace

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="doubao_tts",
            description="将文本转换为语音，生成 MP3 音频文件。支持多种音色（女声/男声），"
                        "可调节语速和音量。适用于朗读文章、语音回复、有声内容生成。",
            parameters={
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "要转换为语音的文本内容，支持中文/英文/日文等多语言。",
                    },
                    "speaker": {
                        "type": "string",
                        "description": f"音色选择，可用: zh_female_qingxin(清新女声)/zh_male_qingse(清澈男声)/"
                                     f"zh_female_xiaoling(小玲)/zh_male_xiaoming(小明)。默认: {self.default_speaker}",
                        "default": self.default_speaker,
                    },
                    "speed": {
                        "type": "number",
                        "description": "语速，范围 0.5-2.0，1.0 为正常语速",
                        "default": 1.0,
                    },
                    "volume": {
                        "type": "number",
                        "description": "音量，范围 0.5-2.0，1.0 为正常音量",
                        "default": 1.0,
                    },
                    "output_file": {
                        "type": "string",
                        "description": "输出文件路径（相对于工作区），如 'output/tts_output.mp3'。",
                    },
                },
                "required": ["text"],
            },
        )

    async def execute(self, arguments: Dict[str, Any]) -> ToolResult:
        text = arguments["text"]
        speaker = arguments.get("speaker", self.default_speaker)
        speed = arguments.get("speed", 1.0)
        volume = arguments.get("volume", 1.0)
        output_file = arguments.get("output_file", "output/tts_output.mp3")

        # Speed/volume to API range: -50 to 100
        speech_rate = int((speed - 1.0) * 100)
        loudness_rate = int((volume - 1.0) * 100)

        payload = {
            "req_params": {
                "text": text,
                "speaker": speaker,
                "audio_params": {
                    "format": "mp3",
                    "speech_rate": max(-50, min(100, speech_rate)),
                    "loudness_rate": max(-50, min(100, loudness_rate)),
                },
            }
        }

        try:
            import uuid
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(
                    "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
                    json=payload,
                    headers={
                        "X-Api-Key": self.api_key,
                        "X-Api-Resource-Id": self.resource_id,
                        "X-Api-Request-Id": str(uuid.uuid4()),
                        "Content-Type": "application/json",
                    },
                )

                if resp.status_code == 403:
                    return ToolResult(
                        success=False,
                        output="",
                        error="豆包语音 TTS 服务未开通。请在豆包语音控制台开通 TTS 服务后再试。",
                    )

                resp.raise_for_status()

                # Save audio
                full_path = Path(self.workspace) / output_file
                full_path.parent.mkdir(parents=True, exist_ok=True)
                full_path.write_bytes(resp.content)

                return ToolResult(
                    success=True,
                    output=f"语音生成成功！\n"
                           f"文件: {full_path}\n"
                           f"文本: {text[:50]}{'...' if len(text) > 50 else ''}\n"
                           f"音色: {speaker}\n"
                           f"大小: {len(resp.content)} bytes",
                    metadata={
                        "file": str(full_path),
                        "size_bytes": len(resp.content),
                        "speaker": speaker,
                        "text_length": len(text),
                    },
                )
        except httpx.HTTPStatusError as e:
            return ToolResult(
                success=False, output="",
                error=f"TTS API 错误 ({e.response.status_code}): {e.response.text[:300]}"
            )
        except Exception as e:
            return ToolResult(success=False, output="", error=f"TTS 生成失败: {e}")


class DoubaoAsrTool(BaseTool):
    """豆包语音识别 — 语音转文本。"""

    def __init__(self, api_key: str, resource_id: str = "volc.bigasr.sauc.duration",
                 workspace: str = "."):
        self.api_key = api_key
        self.resource_id = resource_id
        self.workspace = workspace

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="doubao_asr",
            description="将音频文件（MP3/WAV/M4A）转换为文字。支持中文/英文/中日韩等多语言。",
            parameters={
                "type": "object",
                "properties": {
                    "audio_file": {
                        "type": "string",
                        "description": "音频文件路径（相对于工作区），如 'recording.wav'。",
                    },
                    "language": {
                        "type": "string",
                        "description": "语言，可选 zh-cn/en/ja/ko，默认 zh-cn",
                        "default": "zh-cn",
                    },
                },
                "required": ["audio_file"],
            },
        )

    async def execute(self, arguments: Dict[str, Any]) -> ToolResult:
        audio_file = arguments["audio_file"]
        full_path = Path(self.workspace) / audio_file if not os.path.isabs(audio_file) else Path(audio_file)

        if not full_path.exists():
            return ToolResult(success=False, output="", error=f"音频文件不存在: {full_path}")

        try:
            # ASR requires file upload via multipart
            import uuid
            async with httpx.AsyncClient(timeout=120) as client:
                with open(full_path, "rb") as f:
                    files = {"audio": (full_path.name, f)}
                    resp = await client.post(
                        "https://openspeech.bytedance.com/api/v3/asr",
                        files=files,
                        data={
                            "language": arguments.get("language", "zh-cn"),
                        },
                        headers={
                            "X-Api-Key": self.api_key,
                            "X-Api-Resource-Id": self.resource_id,
                            "X-Api-Request-Id": str(uuid.uuid4()),
                        },
                    )

                if resp.status_code == 403:
                    return ToolResult(
                        success=False, output="",
                        error="豆包语音 ASR 服务未开通。请在豆包语音控制台开通 ASR 服务。"
                    )

                resp.raise_for_status()
                data = resp.json()
                text = data.get("text", "") or data.get("result", {}).get("text", "")

                return ToolResult(
                    success=True,
                    output=f"语音识别结果: {text}" if text else "未识别到文本内容",
                    metadata={"file": str(full_path), "text": text},
                )
        except httpx.HTTPStatusError as e:
            return ToolResult(
                success=False, output="",
                error=f"ASR API 错误 ({e.response.status_code}): {e.response.text[:300]}"
            )
        except Exception as e:
            return ToolResult(success=False, output="", error=f"ASR 识别失败: {e}")


# ============================================================
# Tool Registry
# ============================================================

class ToolRegistry:
    """
    Central tool registry — manages all available tools.

    Usage:
        registry = ToolRegistry(workspace="/path/to/workspace")
        registry.register(BashTool())
        registry.register(FileReadTool())

        # Get definitions for the model
        tool_defs = registry.get_definitions()

        # Execute a tool call from the model
        result = await registry.execute("bash", {"command": "ls -la"})
    """

    def __init__(self, workspace: str = "."):
        self.workspace = workspace
        self._tools: Dict[str, BaseTool] = {}
        self._history: List[Tuple[str, ToolResult]] = []

    def register(self, tool: BaseTool):
        """Register a tool."""
        self._tools[tool.name] = tool

    def register_all(self, tools: List[BaseTool]):
        for t in tools:
            self.register(t)

    def get(self, name: str) -> Optional[BaseTool]:
        return self._tools.get(name)

    def get_definitions(self, names: Optional[List[str]] = None) -> List[ToolDefinition]:
        """Get tool definitions for the model."""
        if names:
            return [t.definition for name in names if (t := self._tools.get(name))]
        return [t.definition for t in self._tools.values()]

    async def execute(self, name: str, arguments: Dict[str, Any]) -> ToolResult:
        """
        Execute a tool by name with the given arguments.
        This is the central dispatch that the Agent Loop calls.
        """
        tool = self._tools.get(name)
        if not tool:
            result = ToolResult(
                success=False,
                output="",
                error=f"Unknown tool: {name}. Available: {list(self._tools.keys())}",
            )
            self._history.append((name, result))
            return result

        try:
            start = time.time()
            result = await tool.execute(arguments)
            elapsed = time.time() - start
            result.metadata["elapsed_ms"] = round(elapsed * 1000)
            self._history.append((name, result))
            return result
        except Exception as e:
            result = ToolResult(success=False, output="", error=f"{name}: {e}")
            self._history.append((name, result))
            return result

    def get_history(self) -> List[Tuple[str, ToolResult]]:
        return self._history

    def list_tools(self) -> List[str]:
        return list(self._tools.keys())


# ============================================================
# Factory: create default tool set
# ============================================================

def create_default_tools(workspace: str = ".") -> ToolRegistry:
    """Create a ToolRegistry with all built-in tools pre-registered."""
    registry = ToolRegistry(workspace=workspace)
    registry.register(BashTool(workspace=workspace))
    registry.register(FileReadTool(workspace=workspace))
    registry.register(FileWriteTool(workspace=workspace))
    registry.register(WebSearchTool())
    registry.register(WebFetchTool())

    # 豆包语音 TTS / ASR（需要 DOUBAO_VOICE_API_KEY）
    voice_key = os.environ.get("DOUBAO_VOICE_API_KEY", "")
    if voice_key:
        registry.register(DoubaoTtsTool(api_key=voice_key, workspace=workspace))
        registry.register(DoubaoAsrTool(api_key=voice_key, workspace=workspace))

    return registry
