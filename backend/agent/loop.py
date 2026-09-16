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
    r"我(将|会|要|打算|准备)\s*(使用|调用|进行|执行).{0,30}(search|搜索|fetch|抓取|查询|浏览|查找)",
    r"我(将|会|要|打算|准备).{0,12}(为您|帮你|给你)?(查找|查询|搜索|检索|了解一下)",
    r"(使用|调用)\s*(web_search|web_fetch)\s*工具",
    r"(正在|先).{0,8}(为您|帮你)?(查找|查询|搜索|检索)",
    r"请稍等|稍等一下|稍候|请等待|马上回来|我去查一下|让我查一下|让我搜索",
    r"(我来|让我|我将|我会).{0,12}(直接)?(运行|执行|生成|绘制|画).{0,20}(图表|代码|可视化|示意图)",
    r"(直接运行|开始生成|正在生成|这就生成).{0,16}(图表|代码|可视化)",
    r"let me (search|fetch|look up|use the tool|generate|run|create).{0,20}(chart|plot|graph|code)",
    r"I('ll| will) (search|fetch|look up|use the tool|generate|run|create).{0,20}(chart|plot|graph|code)",
    r"首先.{0,15}(搜索|查询|访问|查找).{0,15}(然后|接着|再)",
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


_ANSWER_NOW_NUDGE = (
    "停止计划与空话。不要再说「请稍等」「我将查找」「我来生成」。"
    "不要再调用任何工具。"
    "请立即基于你已有知识，直接给出完整、具体、可阅读的最终答案。"
    "若信息可能不是最新的，在开头用一句话注明即可。"
)

_CHART_NUDGE = (
    "用户要的是可直接查看的图表，不是计划也不是承诺。"
    "禁止只回复「我来生成图表/我来运行代码」。"
    "请立刻输出完整可渲染内容，优先顺序："
    "1) 纯 SVG 图表（最推荐，便于保存图片）；"
    "2) ```html 完整 HTML，用纯 SVG/CSS 画图，尽量不要依赖 Chart.js 等外部 CDN；"
    "3) ```mermaid。"
    "可用示意数据，开头注明「示意数据，非实时行情」。不要调用工具。"
)


def _has_deliverable_artifact(text: str) -> bool:
    if not text:
        return False
    lower = text.lower()
    if "```html" in lower or "```svg" in lower or "```mermaid" in lower:
        return True
    if "<svg" in lower or "<!doctype html" in lower or "<canvas" in lower:
        return True
    if re.search(r"```(?:javascript|js|python|py)\n.{80,}", text, re.I | re.S):
        return True
    return False


def _looks_like_wait_only(text: str) -> bool:
    """短回复几乎只有「稍等/去查/去生成」，没有实质内容。"""
    if not text:
        return False
    stripped = text.strip()
    if len(stripped) > 180:
        return False
    if _has_deliverable_artifact(stripped):
        return False
    if re.search(
        r"(稍等|稍候|查找|查询|搜索|检索|去查|了解一下|为您查找|"
        r"我来.{0,10}(运行|生成|绘制)|直接运行|生成图表|生成.*代码)",
        stripped,
    ):
        substance = (
            "股价", "市值", "营收", "结论", "建议", "具体", "目前", "约为",
            "根据", "如下", "%", "元", "美元", "港股", "代码", "上市", "分析",
            "```", "<svg", "<html",
        )
        return not any(s in stripped for s in substance)
    return False


def _looks_like_empty_promise(text: str) -> bool:
    """模型只说「我来生成/运行…」却没有真正交付内容。"""
    if not text:
        return False
    stripped = text.strip()
    if _has_deliverable_artifact(stripped):
        return False
    if len(stripped) > 220:
        # 长文若仍几乎全是计划句、没有交付物，也视为空承诺
        if not re.search(r"(我来|让我|我将|直接运行|生成图表|运行代码)", stripped):
            return False
        body = re.sub(
            r"(我来|让我|我将|我会).{0,20}(运行|执行|生成|绘制).{0,30}(图表|代码|可视化)",
            "",
            stripped,
        )
        return len(body.strip()) < 40
    return bool(_TOOL_PLAN_RE.search(stripped)) or _looks_like_wait_only(stripped)


def _looks_like_tool_plan(text: str) -> bool:
    """Return True if the model output describes a tool call / future action
    in plain text without actually delivering an answer or artifact."""
    if not text:
        return False
    if _has_deliverable_artifact(text):
        return False
    if _TOOL_PLAN_RE.search(text):
        return True
    tool_names = ("web_search", "web_fetch", "bash", "grep", "glob")
    if any(name in text for name in tool_names) and len(text) < 800:
        result_markers = ("结果", "答案是", "根据", "据", "结论", "综上", "result", "according to", "answer:")
        if not any(m in text.lower() for m in result_markers):
            return True
    if _looks_like_empty_promise(text):
        return True
    return False


def _conversation_wants_chart(messages: List[Any]) -> bool:
    for m in reversed(messages or []):
        role = getattr(m, "role", None)
        content = getattr(m, "content", None) or ""
        if role == Role.USER and content:
            if re.search(r"图表|圖表|可视化|示意(图|圖)|画(一|张|个)?图|走势图|K线|柱状|折线|chart|plot|graph", content, re.I):
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
        history: Optional[List[Dict[str, Any]]] = None,
    ):
        self.provider = provider
        self.tools = tools
        self.memory = memory
        self.config = config
        self._model = model
        self._images = images or []
        self._history = history or []

        # Runtime state
        self._messages: List[Message] = []
        self._steps: List[AgentStep] = []
        self._status: AgentStatus = AgentStatus.IDLE
        self._turn_count: int = 0

    def _seed_messages(self, user_message: str, system_content: str) -> None:
        """Initialize conversation with system + prior turns + current user message."""
        self._messages = [Message(role=Role.SYSTEM, content=system_content)]
        for item in self._history[-20:]:
            if not isinstance(item, dict):
                continue
            role = str(item.get("role") or "").lower()
            content = str(item.get("content") or "").strip()
            if not content:
                continue
            if role == "user":
                self._messages.append(Message(role=Role.USER, content=content[:8000]))
            elif role == "assistant":
                self._messages.append(Message(role=Role.ASSISTANT, content=content[:8000]))
        self._messages.append(
            Message(
                role=Role.USER,
                content=user_message,
                images=self._images if self._images else None,
            )
        )

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

        # Initialize message list (system + prior turns + current user)
        self._seed_messages(user_message, system_content)

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
            # ── Check for hallucinated tool plan (model says it'll use a tool but didn't) ──
            if response.is_text and _looks_like_tool_plan(response.content or ""):
                logger.info(
                    f"Turn {self._turn_count}: wait/plan without answer — forcing direct answer"
                )
                self._messages.append(Message(role=Role.ASSISTANT, content=response.content or ""))
                self._messages.append(Message(role=Role.USER, content=self._pick_nudge()))
                stalled = True
                self._steps.append(AgentStep(
                    step_num=self._turn_count,
                    status=AgentStatus.THINKING,
                    model_response=response,
                ))
                break

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

        self._seed_messages(user_message, system_content)

        tool_defs = [] if self.config.disable_tools else self.tools.get_definitions()
        logger.info(
            f"run_stream start: model={self._effective_model()} "
            f"history={len(self._history)} msgs={len(self._messages)} "
            f"tools={[t.name for t in tool_defs]}"
        )

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
                    # 工具执行前不要发 text_end，否则前端会误以为整轮结束、无法追问
                    if streamed:
                        yield json.dumps({
                            "type": "status",
                            "status": "thinking",
                            "turn": self._turn_count,
                            "note": "正在调用工具…",
                        }) + "\n"

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
                        if full_text and (
                            _looks_like_empty_promise(full_text) or _looks_like_tool_plan(full_text)
                        ):
                            yield json.dumps({"type": "text_reset"}) + "\n"
                            yield json.dumps({
                                "type": "status",
                                "status": "thinking",
                                "turn": self._turn_count,
                                "note": "正在生成图表…",
                            }) + "\n"
                        self._messages.append(Message(
                            role=Role.USER,
                            content=self._pick_nudge(),
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
                if (
                    _looks_like_tool_plan(full_text) or _is_self_talk_loop(full_text)
                ) and self._turn_count < self.config.max_turns:
                    logger.info(
                        f"Turn {self._turn_count}: wait/plan or self-talk "
                        f"(retries={_retry_attempt_count(full_text)}) — forcing direct answer"
                    )
                    # 清掉前端已显示的空话，马上进入直接作答
                    if streamed:
                        yield json.dumps({"type": "text_reset"}) + "\n"
                        yield json.dumps({
                            "type": "status",
                            "status": "thinking",
                            "turn": self._turn_count,
                            "note": "正在作答…",
                        }) + "\n"

                    self._messages.append(Message(role=Role.ASSISTANT, content=full_text))
                    self._messages.append(Message(role=Role.USER, content=self._pick_nudge()))
                    stalled = True
                    self._steps.append(AgentStep(
                        step_num=self._turn_count,
                        status=AgentStatus.THINKING,
                        model_response=ChatResponse(content=full_text, model=self._effective_model() or ""),
                    ))
                    break  # 直接走 synthesis，不再空转工具

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
                if _looks_like_tool_plan(response.content or "") and self._turn_count < self.config.max_turns:
                    logger.info(
                        f"Turn {self._turn_count}: non-stream wait/plan — forcing direct answer"
                    )
                    # 不要把空承诺推给用户，直接进入综合作答
                    yield json.dumps({"type": "text_reset"}) + "\n"
                    yield json.dumps({
                        "type": "status",
                        "status": "thinking",
                        "turn": self._turn_count,
                        "note": "正在作答…",
                    }) + "\n"

                    self._messages.append(Message(role=Role.ASSISTANT, content=response.content or ""))
                    self._messages.append(Message(role=Role.USER, content=self._pick_nudge()))
                    stalled = True
                    self._steps.append(AgentStep(
                        step_num=self._turn_count,
                        status=AgentStatus.THINKING,
                        model_response=response,
                    ))
                    break

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
                        content=self._pick_nudge(),
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
                self._messages.append(Message(role=Role.USER, content=self._pick_nudge()))
            try:
                yield json.dumps({
                    "type": "status",
                    "status": "thinking",
                    "turn": self._turn_count,
                    "note": "正在生成完整回答…",
                }) + "\n"
                synthesis = await self.provider.chat(
                    messages=self._build_synthesis_messages(),
                    tools=None,
                    model=self._effective_model(),
                    temperature=self.config.temperature,
                    max_tokens=self.config.max_tokens,
                )
                # 若仍是空承诺，再强制一次图表/答案交付
                if synthesis.is_text and _looks_like_empty_promise(synthesis.content or ""):
                    logger.info("Synthesis still empty promise — retrying with stronger nudge")
                    retry_msgs = self._build_synthesis_messages()
                    retry_msgs.append(Message(role=Role.USER, content=self._pick_nudge()))
                    synthesis = await self.provider.chat(
                        messages=retry_msgs,
                        tools=None,
                        model=self._effective_model(),
                        temperature=0.4,
                        max_tokens=self.config.max_tokens,
                    )
                if synthesis.is_text and synthesis.content and not _looks_like_empty_promise(synthesis.content):
                    yield json.dumps({"type": "text_start"}) + "\n"
                    text = synthesis.content
                    # 中文友好：按字符块推送，避免整段卡住
                    chunk_size = 48
                    for i in range(0, len(text), chunk_size):
                        chunk = text[i:i + chunk_size]
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
                if synthesis.is_text and synthesis.content:
                    # 最后兜底：即使仍偏短，也输出，避免前端空白
                    yield json.dumps({"type": "text_reset"}) + "\n"
                    yield json.dumps({"type": "text_start"}) + "\n"
                    yield json.dumps({"type": "text", "content": synthesis.content}) + "\n"
                    yield json.dumps({"type": "text_end"}) + "\n"
                    self._messages.append(Message(role=Role.ASSISTANT, content=synthesis.content))
                    self._status = AgentStatus.DONE
                    return
            except Exception as e:
                logger.warning(f"Synthesis call failed: {e}")

        yield json.dumps({"type": "error", "message": "未能生成完整回答，请重试"}) + "\n"

    # ── Internal ────────────────────────────────────────────

    def _pick_nudge(self) -> str:
        if _conversation_wants_chart(self._messages):
            return _CHART_NUDGE
        return _ANSWER_NOW_NUDGE

    def _build_synthesis_messages(self) -> List[Message]:
        """Build a clean context for final synthesis — avoids broken tool-call chains."""
        msgs: List[Message] = []
        if self._messages and self._messages[0].role == Role.SYSTEM:
            msgs.append(self._messages[0])
        nudge_prefixes = (
            "工具调用已经",
            "请直接基于",
            "停止计划与空话",
            "你刚才只说了",
            "你刚才说要调用",
            "用户要的是可直接查看的图表",
        )
        for m in self._messages[1:]:
            if m.role not in (Role.USER, Role.ASSISTANT):
                continue
            content = (m.content or "").strip()
            if not content:
                continue
            if m.role == Role.USER and any(content.startswith(p) for p in nudge_prefixes):
                continue
            if m.role == Role.ASSISTANT and (
                _looks_like_wait_only(content) or _looks_like_empty_promise(content)
            ):
                continue
            msgs.append(Message(role=m.role, content=content[:6000]))
        msgs.append(Message(role=Role.USER, content=self._pick_nudge()))
        # 保留 system + 最近若干轮
        if len(msgs) > 14:
            msgs = [msgs[0]] + msgs[-13:]
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
