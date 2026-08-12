"""
WorkBuddy Agent Loop — 核心调度引擎

这是整件事的心脏。Agent Loop 驱动 LLM 完成多步任务：

  1. Analyze: 分析当前上下文和用户意图
  2. Think: 决定是否需要调用工具
  3. Act:  选中工具并调用
  4. Observe: 观察工具执行结果
  5. Iterate: 将结果注入上下文，回到步骤 1

循环终止条件：模型返回纯文本（无 tool call）或达到 max_turns。

模型就是这样被"抓到"并驱动的——Agent Loop 是司机，模型是引擎，
工具是轮子，记忆是地图。
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Dict, List, Optional

from models.adapter import (
    ChatResponse,
    Message,
    ModelProvider,
    Role,
    ToolCall,
    ToolDefinition,
)
from agent.tools import ToolRegistry, ToolResult
from agent.memory import MemoryManager

logger = logging.getLogger(__name__)


# ============================================================
# Agent State
# ============================================================

class AgentStatus(str, Enum):
    IDLE = "idle"
    THINKING = "thinking"
    EXECUTING = "executing"
    DONE = "done"
    ERROR = "error"


@dataclass
class AgentStep:
    """One step in the agent loop."""
    step_num: int
    status: AgentStatus
    model_response: Optional[ChatResponse] = None
    tool_results: List[ToolResult] = field(default_factory=list)
    error: Optional[str] = None


@dataclass
class AgentConfig:
    """Configuration for the agent loop."""
    max_turns: int = 30
    max_response_length: int = 8000
    temperature: float = 0.3
    workspace_root: str = "."
    system_prompt: str = "You are WorkBuddy, a powerful AI assistant."


# ============================================================
# Agent Loop
# ============================================================

class AgentLoop:
    """
    The core agent loop.

    Usage:
        loop = AgentLoop(provider, tools, memory, config)
        result = await loop.run("帮我写一个数据分析脚本")
    """

    def __init__(
        self,
        provider: ModelProvider,
        tools: ToolRegistry,
        memory: MemoryManager,
        config: AgentConfig,
    ):
        self.provider = provider
        self.tools = tools
        self.memory = memory
        self.config = config

        # Runtime state
        self._messages: List[Message] = []
        self._steps: List[AgentStep] = []
        self._status: AgentStatus = AgentStatus.IDLE
        self._turn_count: int = 0

    # ── Public API ──────────────────────────────────────────

    async def run(self, user_message: str) -> str:
        """
        Execute a full agent run for a user message.

        Returns the final assistant response text.
        """
        return await self.run_with_callbacks(user_message)

    async def run_with_callbacks(
        self,
        user_message: str,
        on_thinking: Optional[Callable[[int], None]] = None,
        on_tool_start: Optional[Callable[[str, Dict[str, Any]], None]] = None,
        on_tool_result: Optional[Callable[[str, ToolResult], None]] = None,
        on_text: Optional[Callable[[str], None]] = None,
    ) -> str:
        self._reset()

        # Inject memory context
        mem_ctx = self.memory.get_context()
        system_content = self.config.system_prompt
        if mem_ctx.to_prompt_text():
            system_content += "\n\n" + mem_ctx.to_prompt_text()

        # Initialize message list
        self._messages = [
            Message(role=Role.SYSTEM, content=system_content),
            Message(role=Role.USER, content=user_message),
        ]

        tool_defs = self.tools.get_definitions()

        # ── The Loop ──
        while self._turn_count < self.config.max_turns:
            self._turn_count += 1
            self._status = AgentStatus.THINKING

            if on_thinking:
                on_thinking(self._turn_count)

            # 1. Call the model
            logger.info(f"[Turn {self._turn_count}] Calling model...")
            response = await self.provider.chat(
                messages=self._messages,
                tools=tool_defs,
                temperature=self.config.temperature,
            )

            self._messages.append(
                Message(
                    role=Role.ASSISTANT,
                    content=response.content,
                    tool_calls=response.tool_calls,
                )
            )

            # 2. Check: text response or tool call?
            # Note: Some models (DeepSeek V3) return both text AND tool_calls
            # in the same response. Always execute tools first when present.
            if response.is_tool_call:
                # 3. Execute tools
                self._status = AgentStatus.EXECUTING

                for tc in response.tool_calls:
                    if on_tool_start:
                        on_tool_start(tc.name, tc.arguments)

                tool_results = await self._execute_tools(response.tool_calls)

                for tc, tr in zip(response.tool_calls, tool_results):
                    if on_tool_result:
                        on_tool_result(tc.name, tr)

                # 4. Inject tool results into messages
                for tc, tr in zip(response.tool_calls, tool_results):
                    self._messages.append(Message(
                        role=Role.TOOL,
                        content=tr.to_summary(),
                        tool_call_id=tc.id,
                        name=tc.name,
                    ))

                self._steps.append(AgentStep(
                    step_num=self._turn_count,
                    status=AgentStatus.EXECUTING,
                    model_response=response,
                    tool_results=tool_results,
                ))

                # Log tool usage
                for tc, tr in zip(response.tool_calls, tool_results):
                    self.memory.log_work(
                        f"Tool: {tc.name}({json.dumps(tc.arguments, ensure_ascii=False)[:200]}) → "
                        f"{'OK' if tr.success else 'ERR'}"
                    )

                # Continue loop — model will process results
                continue

            # Fallback
            self._status = AgentStatus.DONE
            return response.content or ""

        # Max turns reached
        self._status = AgentStatus.DONE
        return "[Agent stopped — max turns reached. The task may be incomplete.]"

    async def run_stream(self, user_message: str) -> AsyncIterator[str]:
        """
        Execute with streaming output for the final response.

        Yields status updates and final text chunks.
        """
        self._reset()

        # Inject memory
        mem_ctx = self.memory.get_context()
        system_content = self.config.system_prompt
        if mem_ctx.to_prompt_text():
            system_content += "\n\n" + mem_ctx.to_prompt_text()

        self._messages = [
            Message(role=Role.SYSTEM, content=system_content),
            Message(role=Role.USER, content=user_message),
        ]

        tool_defs = self.tools.get_definitions()

        # ── The Loop (non-streaming for tool calls) ──
        while self._turn_count < self.config.max_turns:
            self._turn_count += 1
            self._status = AgentStatus.THINKING

            yield json.dumps({"type": "status", "status": "thinking", "turn": self._turn_count}) + "\n"

            response = await self.provider.chat(
                messages=self._messages,
                tools=tool_defs,
                temperature=self.config.temperature,
            )

            self._messages.append(
                Message(
                    role=Role.ASSISTANT,
                    content=response.content,
                    tool_calls=response.tool_calls,
                )
            )

            if response.is_text and not response.is_tool_call:
                # Stream the final text
                yield json.dumps({"type": "text_start"}) + "\n"
                for char in response.content or "":
                    yield json.dumps({"type": "text", "content": char}) + "\n"
                    await asyncio.sleep(0.01)
                yield json.dumps({"type": "text_end"}) + "\n"

                self._status = AgentStatus.DONE
                self._steps.append(AgentStep(
                    step_num=self._turn_count,
                    status=AgentStatus.DONE,
                    model_response=response,
                ))

                self.memory.log_work(f"Completed in {self._turn_count} turns")
                return

            if response.is_tool_call:
                self._status = AgentStatus.EXECUTING

                for tc in response.tool_calls:
                    yield json.dumps({
                        "type": "tool_call",
                        "tool": tc.name,
                        "args": tc.arguments,
                    }) + "\n"

                tool_results = await self._execute_tools(response.tool_calls)

                for tc, tr in zip(response.tool_calls, tool_results):
                    yield json.dumps({
                        "type": "tool_result",
                        "tool": tc.name,
                        "success": tr.success,
                        "summary": tr.output[:200],
                    }) + "\n"

                    self._messages.append(Message(
                        role=Role.TOOL,
                        content=tr.to_summary(),
                        tool_call_id=tc.id,
                        name=tc.name,
                    ))

                self._steps.append(AgentStep(
                    step_num=self._turn_count,
                    status=AgentStatus.EXECUTING,
                    model_response=response,
                    tool_results=tool_results,
                ))

                for tc, tr in zip(response.tool_calls, tool_results):
                    self.memory.log_work(
                        f"Tool: {tc.name}({json.dumps(tc.arguments, ensure_ascii=False)[:200]})"
                    )
                continue

            break

        yield json.dumps({"type": "error", "message": "Max turns reached"}) + "\n"

    # ── Internal ────────────────────────────────────────────

    def _reset(self):
        self._messages = []
        self._steps = []
        self._status = AgentStatus.IDLE
        self._turn_count = 0

    async def _execute_tools(self, tool_calls: List[ToolCall]) -> List[ToolResult]:
        """Execute multiple tool calls (in parallel when possible)."""
        tasks = []
        for tc in tool_calls:
            tasks.append(self.tools.execute(tc.name, tc.arguments))

        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Handle exceptions
        processed = []
        for i, r in enumerate(results):
            if isinstance(r, Exception):
                processed.append(ToolResult(
                    success=False,
                    output="",
                    error=str(r),
                ))
            else:
                processed.append(r)

        return processed

    # ── Properties ──────────────────────────────────────────

    @property
    def status(self) -> AgentStatus:
        return self._status

    @property
    def turn_count(self) -> int:
        return self._turn_count

    @property
    def steps(self) -> List[AgentStep]:
        return self._steps

    def get_conversation(self) -> List[Message]:
        """Get the full conversation history."""
        return self._messages.copy()

    def get_step_log(self) -> str:
        """Get a human-readable log of the agent run."""
        lines = [f"Agent Run — {len(self._steps)} steps"]
        for s in self._steps:
            lines.append(f"\nStep {s.step_num} [{s.status.value}]:")
            if s.model_response:
                if s.model_response.is_text:
                    text = s.model_response.content or ""
                    lines.append(f"  Response: {text[:200]}...")
                if s.model_response.is_tool_call and s.model_response.tool_calls:
                    for tc in s.model_response.tool_calls:
                        lines.append(f"  Tool: {tc.name}(...)")
            if s.tool_results:
                for tr in s.tool_results:
                    status = "OK" if tr.success else "ERR"
                    lines.append(f"  Result: [{status}] {tr.output[:100]}")
            if s.error:
                lines.append(f"  Error: {s.error}")
        return "\n".join(lines)


# ============================================================
# Factory
# ============================================================

def create_agent(
    provider: ModelProvider,
    tools: ToolRegistry,
    memory: MemoryManager,
    config: AgentConfig,
) -> AgentLoop:
    """Create a configured AgentLoop instance."""
    return AgentLoop(
        provider=provider,
        tools=tools,
        memory=memory,
        config=config,
    )
