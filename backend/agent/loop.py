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
import re
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
# Tool-call stream reassembly
# ============================================================

# Patterns that indicate the model *described* using a tool in plain text
# but did not actually emit a function_call. We use these to detect the
# "I'll search the web for..." hallucinated-plan pattern and force the
# model to really invoke the tool on the next turn.
_TOOL_PLAN_PATTERNS = [
    r"我(将|会|要|打算|准备)\s*(使用|调用|进行|执行).{0,30}(search|搜索|fetch|抓取|查询|浏览)",
    r"(使用|调用)\s*(web_search|web_fetch)\s*工具",
    r"let me (search|fetch|look up|use the tool)",
    r"I('ll| will) (search|fetch|look up|use the tool)",
    r"首先.{0,15}(搜索|查询|访问).{0,15}(然后|接着|再)",
    r"step\s*1[:：].{0,40}(step\s*2|todo)",
]

# ── Repeated-attempt patterns: when the model keeps saying "I'll try X..."
# in plain text across multiple turns without actually emitting a tool_call,
# it's stuck in a self-talk loop. We detect this and force synthesis. ──
_RETRY_PHRASES = [
    r"让我(再|继续)?(尝试|试试|试一下|换个|换一种|抓取|访问|搜索|查询|查找)",
    r"我(再|继续)?(尝试|试试|试一下|换个|换一种|抓取|访问|搜索|查询|查找)",
    r"(让我|我)\s*直接\s*(抓取|访问|搜索|查询|打开)",
    r"(再试一次|再换个|换个方式|换个工具|换一个渠道)",
    r"let me (try|attempt|use) (another|a different|again)",
]
_RETRY_RE = re.compile("|".join(_RETRY_PHRASES), re.IGNORECASE)


def _retry_attempt_count(text: str) -> int:
    """Count how many times the model says 'let me try another...' phrases.
    High counts indicate the model is in a self-talk loop."""
    if not text:
        return 0
    return len(_RETRY_RE.findall(text))


_TOOL_PLAN_RE = re.compile("|".join(_TOOL_PLAN_PATTERNS), re.IGNORECASE)


def _looks_like_tool_plan(text: str) -> bool:
    """Return True if the model output describes a tool call in plain
    text without actually emitting a function_call."""
    if not text:
        return False
    # Short "planning" text + presence of tool name in natural language
    if _TOOL_PLAN_RE.search(text):
        return True
    # Heuristic: if text mentions a known tool name but doesn't end with
    # a real answer, treat it as a plan
    tool_names = ("web_search", "web_fetch", "bash", "grep", "glob")
    if any(name in text for name in tool_names) and len(text) < 800:
        # Check if the text is mostly a "plan" rather than actual results
        result_markers = ("结果", "答案是", "根据", "据", "结论", "综上", "result", "according to", "answer:")
        if not any(m in text.lower() for m in result_markers):
            return True
    return False


def _is_self_talk_loop(text: str) -> bool:
    """Return True if the model is repeating 'let me try another...' phrases
    without actually emitting a tool_call — a stall pattern.

    Catches the case where the model outputs long streams of self-talk like
    "让我尝试搜索... 搜索失败... 让我尝试抓取... 抓取失败... 让我再换个渠道..."
    which `_looks_like_tool_plan` misses because the text is too long.
    """
    if not text:
        return False
    retries = _retry_attempt_count(text)
    # 2+ retry phrases = model is stuck in self-talk loop
    return retries >= 2


def _assemble_tool_call_deltas(deltas: List[Dict[str, Any]]) -> List[ToolCall]:
    """Reassemble streamed tool_call deltas into a list of ToolCall objects.

    OpenAI streams tool calls as a series of deltas with keys:
      - index: which tool call this delta belongs to
      - id: the call id (only on the first delta)
      - function.name: tool name (only on the first delta)
      - function.arguments: argument string fragments (across multiple deltas)
    """
    by_index: Dict[int, Dict[str, Any]] = {}
    for d in deltas:
        idx = d.get("index", 0)
        if idx not in by_index:
            by_index[idx] = {"id": "", "name": "", "args_str": ""}
        entry = by_index[idx]
        if "id" in d and d["id"]:
            entry["id"] = d["id"]
        fn = d.get("function") or {}
        if isinstance(fn, dict):
            if "name" in fn and fn["name"]:
                entry["name"] += fn["name"]
            if "arguments" in fn and fn["arguments"] is not None:
                entry["args_str"] += fn["arguments"]

    out: List[ToolCall] = []
    for idx in sorted(by_index.keys()):
        entry = by_index[idx]
        if not entry["name"]:
            continue
        # Arguments are JSON; tolerate partial JSON by falling back to {}
        try:
            args = json.loads(entry["args_str"]) if entry["args_str"] else {}
        except json.JSONDecodeError:
            args = {"_raw": entry["args_str"]}
        out.append(ToolCall(
            id=entry["id"] or f"call_stream_{idx}",
            name=entry["name"],
            arguments=args,
        ))
    return out


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
    max_response_length: int = 32000
    temperature: float = 0.3
    workspace_root: str = "."
    system_prompt: str = "You are WorkBuddy, a powerful AI assistant."
    max_tokens: int = 16384
    disable_tools: bool = False


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
        model: Optional[str] = None,
        images: Optional[List[str]] = None,
    ):
        self.provider = provider
        self.tools = tools
        self.memory = memory
        self.config = config
        self._model = model
        self._images = images or []

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
            Message(role=Role.USER, content=user_message, images=self._images if self._images else None),
        ]

        tool_defs = [] if self.config.disable_tools else self.tools.get_definitions()

        # ── Stall detection state ──
        result_fingerprints: List[str] = []
        stall_threshold = 2
        stalled = False
        unhelpful_streak = 0

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
                model=self._effective_model(),
                temperature=self.config.temperature,
                max_tokens=self.config.max_tokens,
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

                # ── Stall detection: track tool result fingerprints ──
                for tr in tool_results:
                    result_fingerprints.append(self._fingerprint(tr.output or ""))
                if self._is_stalled(result_fingerprints, stall_threshold):
                    logger.info(
                        f"Turn {self._turn_count}: stalled (same/empty tool results "
                        f"for {stall_threshold} turns) — forcing synthesis"
                    )
                    stalled = True
                elif self._results_look_unhelpful(tool_results):
                    unhelpful_streak += 1
                    logger.info(
                        f"Turn {self._turn_count}: results look unhelpful "
                        f"(streak={unhelpful_streak})"
                    )
                    if unhelpful_streak >= 2:
                        stalled = True
                else:
                    unhelpful_streak = 0  # reset if we got useful data

                if stalled:
                    self._messages.append(Message(
                        role=Role.USER,
                        content=(
                            "工具调用已经重复多次但没有获得有用的新信息。请基于现有结果和"
                            "你自己的知识给出最终答复，不要再调用工具。"
                            "如果信息可能不是最新的，请明确告知用户。"
                        ),
                    ))
                    break  # exit the loop, run final synthesis

                # Continue loop — model will process results
                continue

            # ── Check for hallucinated tool plan (model says it'll use a tool but didn't) ──
            if tool_defs and response.is_text and _looks_like_tool_plan(response.content or ""):
                logger.info(
                    f"Turn {self._turn_count}: model declared tool usage "
                    "without emitting a tool_call — pushing back for real call"
                )
                self._messages.append(Message(
                    role=Role.USER,
                    content=(
                        "你刚才说要调用工具，但实际并没有发出工具调用。"
                        "请立即在下一轮中真正调用工具（发出 function_call 结构），"
                        "不要再用文字描述计划。如果你已经有足够的信息回答，"
                        "请直接给出完整答案。"
                    ),
                ))
                self._steps.append(AgentStep(
                    step_num=self._turn_count,
                    status=AgentStatus.THINKING,
                    model_response=response,
                ))
                continue

            # Fallback: real final answer
            self._status = AgentStatus.DONE
            self.memory.log_work(f"Completed in {self._turn_count} turns")
            return response.content or ""

        # ── Post-loop synthesis: if stalled or max_turns reached,
        # do one final non-tool call to produce a real answer. ──
        if stalled or self._turn_count >= self.config.max_turns:
            logger.info(
                f"Post-loop synthesis triggered (stalled={stalled}, "
                f"turns={self._turn_count}/{self.config.max_turns})"
            )
            try:
                synthesis = await self.provider.chat(
                    messages=self._build_synthesis_messages(),
                    tools=None,  # disable tools to force text output
                    model=self._effective_model(),
                    temperature=self.config.temperature,
                    max_tokens=self.config.max_tokens,
                )
                if synthesis.is_text and synthesis.content:
                    self._messages.append(
                        Message(role=Role.ASSISTANT, content=synthesis.content)
                    )
                    self._status = AgentStatus.DONE
                    self._steps.append(AgentStep(
                        step_num=self._turn_count + 1,
                        status=AgentStatus.DONE,
                        model_response=synthesis,
                    ))
                    self.memory.log_work(
                        f"Completed in {self._turn_count} turns (synthesized after stall)"
                    )
                    return synthesis.content
            except Exception as e:
                logger.warning(f"Synthesis call failed: {e}")

        self._status = AgentStatus.DONE
        return "[Agent stopped — max turns reached. The task may be incomplete.]"

    async def run_stream(self, user_message: str) -> AsyncIterator[str]:
        """
        Execute with real streaming output.

        Uses provider.chat_stream() for true token-by-token streaming when
        possible, falling back to non-streaming chat() for tool-call rounds.
        No artificial per-character delay — tokens are forwarded as they arrive.
        """
        self._reset()

        # Inject memory
        mem_ctx = self.memory.get_context()
        system_content = self.config.system_prompt
        if mem_ctx.to_prompt_text():
            system_content += "\n\n" + mem_ctx.to_prompt_text()

        self._messages = [
            Message(role=Role.SYSTEM, content=system_content),
            Message(role=Role.USER, content=user_message, images=self._images if self._images else None),
        ]

        tool_defs = [] if self.config.disable_tools else self.tools.get_definitions()
        logger.info(f"run_stream start: model={self._effective_model()} tools={[t.name for t in tool_defs]}")

        # ── Stall detection state ──
        result_fingerprints: List[str] = []
        stall_threshold = 2
        stalled = False
        streamed_final = False

        # ── The Loop ──
        while self._turn_count < self.config.max_turns:
            self._turn_count += 1
            self._status = AgentStatus.THINKING

            yield json.dumps({"type": "status", "status": "thinking", "turn": self._turn_count}) + "\n"

            # ── Try real streaming first ──
            # chat_stream() yields dict events: {"type": "text"|"tool_call_delta"|"done"|"error"}.
            # We forward text tokens to the frontend immediately.
            # We also collect streamed tool_call deltas so we can execute the call
            # without an extra round-trip — and crucially, we detect the case where
            # the model outputs "I'll use web_search..." as plain text but doesn't
            # actually emit a tool_call. In that case we push back into the loop
            # with an "execute the tool" reminder so the model really invokes it.
            full_text = ""
            streamed = False
            tool_call_deltas: List[Dict[str, Any]] = []
            stream_finish_reason = "stop"
            stream_error: Optional[str] = None

            try:
                logger.info(f"Turn {self._turn_count}: calling provider.chat_stream model={self._effective_model()}")
                async for event in self.provider.chat_stream(
                    messages=self._messages,
                    tools=tool_defs if tool_defs else None,
                    model=self._effective_model(),
                    temperature=self.config.temperature,
                    max_tokens=self.config.max_tokens,
                ):
                    evt_type = event.get("type") if isinstance(event, dict) else None
                    if evt_type == "text":
                        token = event.get("content", "")
                        if not token:
                            continue
                        if not streamed:
                            yield json.dumps({"type": "text_start"}) + "\n"
                            streamed = True
                        full_text += token
                        yield json.dumps({"type": "text", "content": token}) + "\n"
                    elif evt_type == "tool_call_delta":
                        tool_call_deltas.append(event.get("delta", {}))
                    elif evt_type == "done":
                        stream_finish_reason = event.get("finish_reason", "stop")
                    elif evt_type == "error":
                        stream_error = event.get("message", "unknown")
                        logger.warning(f"chat_stream error event: {stream_error}")
                logger.info(f"Turn {self._turn_count}: chat_stream done, full_text len={len(full_text)}, deltas={len(tool_call_deltas)}, error={stream_error}")
            except Exception as e:
                logger.warning(f"chat_stream failed, falling back to chat(): {e}")
                full_text = ""
                streamed = False
                tool_call_deltas = []
                stream_error = str(e)

            # ── Case 1a: Got streamed tool calls → assemble and execute ──
            if tool_call_deltas:
                # Assemble streamed tool call deltas into a single ChatResponse
                tool_calls = _assemble_tool_call_deltas(tool_call_deltas)
                if tool_calls:
                    if streamed:
                        yield json.dumps({"type": "text_end"}) + "\n"

                    # If there was also "thinking" text, keep it as a previous-step
                    # assistant message so the tool result can be processed next.
                    if full_text:
                        self._messages.append(
                            Message(role=Role.ASSISTANT, content=full_text, tool_calls=tool_calls)
                        )
                    else:
                        self._messages.append(
                            Message(role=Role.ASSISTANT, content=None, tool_calls=tool_calls)
                        )

                    self._status = AgentStatus.EXECUTING
                    tool_results = await self._execute_tools(tool_calls)

                    # ── Stall detection ──
                    for tr in tool_results:
                        result_fingerprints.append(self._fingerprint(tr.output or ""))
                    if self._is_stalled(result_fingerprints, stall_threshold):
                        logger.info(
                            f"Turn {self._turn_count}: stalled in stream path — forcing synthesis"
                        )
                        stalled = True
                    elif self._results_look_unhelpful(tool_results):
                        logger.info(
                            f"Turn {self._turn_count}: stream results unhelpful — forcing synthesis"
                        )
                        stalled = True

                    if stalled:
                        self._messages.append(Message(
                            role=Role.USER,
                            content=(
                                "工具调用已经重复多次但没有获得有用的新信息。请基于现有结果和"
                                "你自己的知识给出最终答复，不要再调用工具。"
                                "如果信息可能不是最新的，请明确告知用户。"
                            ),
                        ))

                    for tc, tr in zip(tool_calls, tool_results):
                        yield json.dumps({
                            "type": "tool_call",
                            "tool": tc.name,
                            "args": tc.arguments,
                        }) + "\n"
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
                        model_response=ChatResponse(
                            content=full_text or None,
                            tool_calls=tool_calls,
                        ),
                        tool_results=tool_results,
                    ))
                    if stalled:
                        break  # exit loop, run synthesis
                    continue  # Let the next turn produce the final text answer

            # ── Case 1b: Got text from stream (no tool calls) → done, BUT check
            #   if the text is just a "planning" message that didn't actually
            #   invoke a tool. If so, push back and ask the model to really call. ──
            if full_text:
                # If tools are available and the model said it would use one but
                # didn't actually emit a tool_call, treat this as incomplete and
                # push the model back into the loop with a strict instruction.
                if tool_defs and (
                    _looks_like_tool_plan(full_text) or _is_self_talk_loop(full_text)
                ) and self._turn_count < self.config.max_turns:
                    if _is_self_talk_loop(full_text):
                        logger.info(
                            f"Turn {self._turn_count}: model stuck in self-talk loop "
                            f"({_retry_attempt_count(full_text)} retry phrases) — "
                            "forcing synthesis instead"
                        )
                        stalled = True
                        if streamed:
                            yield json.dumps({"type": "text_end"}) + "\n"
                        # Don't push back — go straight to synthesis
                        break
                    logger.info(
                        f"Turn {self._turn_count}: model declared tool usage "
                        "without emitting a tool_call — pushing back for real call"
                    )
                    if streamed:
                        yield json.dumps({"type": "text_end"}) + "\n"

                    # Persist the "plan" text as assistant message
                    self._messages.append(Message(role=Role.ASSISTANT, content=full_text))

                    # Push back: demand an actual tool call next turn
                    self._messages.append(Message(
                        role=Role.USER,
                        content=(
                            "你刚才说要调用工具，但实际并没有发出工具调用。"
                            "请立即在下一轮中真正调用工具（发出 function_call 结构），"
                            "不要再用文字描述计划。"
                        ),
                    ))
                    self._steps.append(AgentStep(
                        step_num=self._turn_count,
                        status=AgentStatus.THINKING,
                        model_response=ChatResponse(content=full_text, model=self._effective_model() or ""),
                    ))
                    continue  # Force another turn

                # Otherwise: real final answer → done
                if streamed:
                    yield json.dumps({"type": "text_end"}) + "\n"

                self._messages.append(
                    Message(role=Role.ASSISTANT, content=full_text)
                )

                self._status = AgentStatus.DONE
                self._steps.append(AgentStep(
                    step_num=self._turn_count,
                    status=AgentStatus.DONE,
                    model_response=ChatResponse(content=full_text, model=self._model or ""),
                ))

                self.memory.log_work(f"Completed in {self._turn_count} turns (streamed)")
                streamed_final = True
                return

            # ── Case 2: No text from stream (and no tool_call deltas) → fallback to chat() ──
            if stream_error and not full_text and not tool_call_deltas:
                yield json.dumps({"type": "error", "message": stream_error}) + "\n"
                return

            # This handles providers that don't forward tool_calls through streaming.
            try:
                response = await self.provider.chat(
                    messages=self._messages,
                    tools=tool_defs,
                    model=self._effective_model(),
                    temperature=self.config.temperature,
                    max_tokens=self.config.max_tokens,
                )
            except Exception as e:
                logger.warning(f"chat() fallback failed: {e}")
                yield json.dumps({"type": "error", "message": str(e)}) + "\n"
                return

            self._messages.append(
                Message(
                    role=Role.ASSISTANT,
                    content=response.content,
                    tool_calls=response.tool_calls,
                )
            )

            if response.is_text and not response.is_tool_call:
                # ── Self-talk loop detection ──
                # Catches "让我尝试...让我尝试..." without tool_call
                if tool_defs and _is_self_talk_loop(response.content or "") and self._turn_count < self.config.max_turns:
                    logger.info(
                        f"Turn {self._turn_count}: non-stream model in self-talk loop "
                        f"({_retry_attempt_count(response.content or '')} retry phrases) — "
                        "forcing synthesis"
                    )
                    stalled = True
                    yield json.dumps({"type": "text_start"}) + "\n"
                    text = response.content or ""
                    words = text.split(" ")
                    chunk_size = 8
                    for i in range(0, len(words), chunk_size):
                        chunk = " ".join(words[i:i + chunk_size])
                        if i + chunk_size < len(words):
                            chunk += " "
                        yield json.dumps({"type": "text", "content": chunk}) + "\n"
                        await asyncio.sleep(0)
                    yield json.dumps({"type": "text_end"}) + "\n"
                    break  # exit the loop, run final synthesis

                # Same anti-hallucinated-plan check, this time on the non-stream path
                if tool_defs and _looks_like_tool_plan(response.content or "") and self._turn_count < self.config.max_turns:
                    logger.info(
                        f"Turn {self._turn_count}: non-stream model declared tool usage "
                        "without tool_call — pushing back for real call"
                    )
                    yield json.dumps({"type": "text_start"}) + "\n"
                    text = response.content or ""
                    words = text.split(" ")
                    chunk_size = 8
                    for i in range(0, len(words), chunk_size):
                        chunk = " ".join(words[i:i + chunk_size])
                        if i + chunk_size < len(words):
                            chunk += " "
                        yield json.dumps({"type": "text", "content": chunk}) + "\n"
                        await asyncio.sleep(0)
                    yield json.dumps({"type": "text_end"}) + "\n"

                    self._messages.append(Message(
                        role=Role.USER,
                        content=(
                            "你刚才说要调用工具，但实际并没有发出工具调用。"
                            "请立即在下一轮中真正调用工具（发出 function_call 结构），"
                            "不要再用文字描述计划。"
                        ),
                    ))
                    self._steps.append(AgentStep(
                        step_num=self._turn_count,
                        status=AgentStatus.THINKING,
                        model_response=response,
                    ))
                    continue

                # Real final answer
                yield json.dumps({"type": "text_start"}) + "\n"
                text = response.content or ""
                words = text.split(" ")
                chunk_size = 8
                for i in range(0, len(words), chunk_size):
                    chunk = " ".join(words[i:i + chunk_size])
                    if i + chunk_size < len(words):
                        chunk += " "
                    yield json.dumps({"type": "text", "content": chunk}) + "\n"
                    await asyncio.sleep(0)
                yield json.dumps({"type": "text_end"}) + "\n"

                self._status = AgentStatus.DONE
                self._steps.append(AgentStep(
                    step_num=self._turn_count,
                    status=AgentStatus.DONE,
                    model_response=response,
                ))

                self.memory.log_work(f"Completed in {self._turn_count} turns")
                streamed_final = True
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

                # ── Stall detection: track tool result fingerprints ──
                for tr in tool_results:
                    result_fingerprints.append(self._fingerprint(tr.output or ""))
                if self._is_stalled(result_fingerprints, stall_threshold):
                    logger.info(
                        f"Turn {self._turn_count}: stalled (same/empty tool results "
                        f"for {stall_threshold} turns) — forcing synthesis"
                    )
                    stalled = True
                elif self._results_look_unhelpful(tool_results):
                    logger.info(
                        f"Turn {self._turn_count}: results look unhelpful "
                        "(short, no price markers) — forcing synthesis"
                    )
                    stalled = True

                if stalled:
                    self._messages.append(Message(
                        role=Role.USER,
                        content=(
                            "工具调用已经重复多次但没有获得有用的新信息。请基于现有结果和"
                            "你自己的知识给出最终答复，不要再调用工具。"
                            "如果信息可能不是最新的，请明确告知用户。"
                        ),
                    ))
                    break  # exit the loop, run final synthesis

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

        # ── Post-loop synthesis: loop ended without a streamed final answer ──
        if not streamed_final:
            if not stalled:
                self._messages.append(Message(
                    role=Role.USER,
                    content=(
                        "请直接基于现有信息和你的知识给出完整答复，不要再调用任何工具。"
                        "如果缺少实时数据，请明确说明并仍给出尽可能完整的分析。"
                    ),
                ))
            try:
                synthesis = await self.provider.chat(
                    messages=self._build_synthesis_messages(),
                    tools=None,
                    model=self._effective_model(),
                    temperature=self.config.temperature,
                    max_tokens=self.config.max_tokens,
                )
                if synthesis.is_text and synthesis.content:
                    yield json.dumps({"type": "text_start"}) + "\n"
                    text = synthesis.content
                    words = text.split(" ")
                    chunk_size = 12
                    for i in range(0, len(words), chunk_size):
                        chunk = " ".join(words[i:i + chunk_size])
                        if i + chunk_size < len(words):
                            chunk += " "
                        yield json.dumps({"type": "text", "content": chunk}) + "\n"
                        await asyncio.sleep(0)
                    yield json.dumps({"type": "text_end"}) + "\n"
                    self._messages.append(
                        Message(role=Role.ASSISTANT, content=synthesis.content)
                    )
                    self._status = AgentStatus.DONE
                    self.memory.log_work(
                        f"Completed in {self._turn_count} turns (synthesized after incomplete loop)"
                    )
                    return
            except Exception as e:
                logger.warning(f"Synthesis call failed: {e}")

        yield json.dumps({"type": "error", "message": "未能生成完整回答，请重试"}) + "\n"

    # ── Internal ────────────────────────────────────────────

    def _build_synthesis_messages(self) -> List[Message]:
        """Build a clean context for final synthesis — avoids broken tool-call chains."""
        msgs: List[Message] = []
        if self._messages and self._messages[0].role == Role.SYSTEM:
            msgs.append(self._messages[0])
        for m in self._messages:
            if m.role == Role.USER and m.content and not m.content.startswith("工具调用已经") and not m.content.startswith("请直接基于"):
                msgs.append(m)
                break
        msgs.append(Message(
            role=Role.USER,
            content=(
                "请直接基于你的知识回答上面的问题，给出完整、有条理的分析。"
                "不要调用任何工具。若缺少实时数据，请说明情况，并仍给出尽可能完整的回答。"
            ),
        ))
        return msgs

    def _resolve_model_name(self) -> Optional[str]:
        """Resolve the model name to send to the provider.

        Handles the special "auto" sentinel — translates it to the current
        provider's default model. Returns None to let the provider decide
        (uses its own default).
        """
        if not self._model or self._model == "auto":
            return getattr(self.provider, "default_model", None)
        return self._model

    def _effective_model(self) -> Optional[str]:
        """Return the model name that should be passed to the provider.

        Use this everywhere we currently pass `self._model`.
        """
        return self._resolve_model_name()

    def _reset(self):
        self._messages = []
        self._steps = []
        self._status = AgentStatus.IDLE
        self._turn_count = 0

    def _fingerprint(self, text: str) -> str:
        """Coarse fingerprint for stall detection."""
        import hashlib
        if not text:
            return "empty"
        # Use first 500 chars + length, then hash
        sample = (text[:500] + f"|{len(text)}").encode("utf-8", errors="ignore")
        return hashlib.md5(sample).hexdigest()

    def _is_stalled(
        self,
        result_fingerprints: List[str],
        threshold: int = 2,
    ) -> bool:
        """Return True if the last `threshold` tool results are identical or empty.

        This catches the "model keeps trying the same web_search / web_fetch and
        getting the same useless answer" loop.
        """
        if len(result_fingerprints) < threshold:
            return False
        recent = result_fingerprints[-threshold:]
        # Empty results count as stall
        if all(fp == "empty" for fp in recent):
            return True
        # All identical non-empty results → stall
        return len(set(recent)) == 1

    def _results_look_unhelpful(self, tool_results) -> bool:
        """Heuristic: all results are short or contain no useful numeric/factual data.

        This catches the case where web_fetch returns HTML pages where the price
        numbers are JS-rendered (so we get navigation text but no actual prices).
        """
        if not tool_results:
            return True
        # Indicators of useful data: numbers with ¥/$/万, model codes, etc.
        useful_markers = ("¥", "$", "万", "元", "指导价", "报价", "售价", "价格", "S400", "S450", "S500", "S580", "price", "Price")
        unhelpful_markers = ("实时搜索暂时不可用", "空结果", "无法实时获取", "搜索引擎返回", "未找到", "No results")
        any_useful = False
        all_short = True
        for tr in tool_results:
            out = tr.output or ""
            if len(out) > 1500:
                all_short = False
            if any(m in out for m in useful_markers):
                any_useful = True
            if any(m in out for m in unhelpful_markers):
                any_useful = False
                break
        # If all results are short (< 1500 chars) AND no useful markers, they're useless
        if any(m in (tr.output or "") for tr in tool_results for m in unhelpful_markers):
            return True
        return all_short and not any_useful

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
    model: Optional[str] = None,
) -> AgentLoop:
    """Create a configured AgentLoop instance."""
    return AgentLoop(
        provider=provider,
        tools=tools,
        memory=memory,
        config=config,
        model=model,
    )
