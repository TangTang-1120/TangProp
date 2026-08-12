"""
WorkBuddy Model Adapter — 统一 LLM 调用抽象层

这是 WorkBuddy 的"模型抓手"：无论底层是 OpenAI、Claude、DeepSeek 还是
混元，对 Agent Loop 来说都是同一个 chat(user_message, tools) 接口。

核心概念：
  1. 所有 provider 都实现 MessageProvider 协议
  2. 统一的 Message 格式 (OpenAI-compatible)
  3. 统一的 Tool Call 格式 (function calling)
  4. 自动 provider 选择和 fallback
"""
from __future__ import annotations

import json
import os
import re
import asyncio
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx


# ============================================================
# Data Models
# ============================================================

class Role(str, Enum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


@dataclass
class ToolCall:
    """A function call requested by the model."""
    id: str
    name: str
    arguments: Dict[str, Any]


@dataclass
class Message:
    """Unified message representation across all providers."""
    role: Role
    content: Optional[str] = None
    tool_calls: Optional[List[ToolCall]] = None
    tool_call_id: Optional[str] = None
    name: Optional[str] = None

    def to_openai(self) -> Dict[str, Any]:
        """Convert to OpenAI-compatible format."""
        msg: Dict[str, Any] = {"role": self.role.value}
        if self.content is not None:
            msg["content"] = self.content
        if self.tool_calls:
            msg["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {"name": tc.name, "arguments": json.dumps(tc.arguments)},
                }
                for tc in self.tool_calls
            ]
        if self.tool_call_id:
            msg["tool_call_id"] = self.tool_call_id
        if self.name:
            msg["name"] = self.name
        return msg


@dataclass
class ToolDefinition:
    """Tool schema definition."""
    name: str
    description: str
    parameters: Dict[str, Any]  # JSON Schema

    def to_openai(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


@dataclass
class ChatResponse:
    """Unified response from any model."""
    content: Optional[str] = None
    tool_calls: Optional[List[ToolCall]] = None
    finish_reason: str = "stop"
    usage: Dict[str, int] = field(default_factory=dict)
    model: str = ""
    streaming: bool = False

    @property
    def is_tool_call(self) -> bool:
        return self.tool_calls is not None and len(self.tool_calls) > 0

    @property
    def is_text(self) -> bool:
        return self.content is not None and len(self.content) > 0


# ============================================================
# Provider Interface
# ============================================================

class ModelProvider(ABC):
    """Abstract LLM provider — the "model handshake" layer."""

    def __init__(self, api_key: str, api_base: str, default_model: str):
        self.api_key = api_key
        self.api_base = api_base.rstrip("/")
        self.default_model = default_model

    @abstractmethod
    async def chat(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        model: Optional[str] = None,
        temperature: float = 0.3,
        max_tokens: int = 4096,
    ) -> ChatResponse:
        """Send a chat request and get a response."""
        ...

    @abstractmethod
    async def chat_stream(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        model: Optional[str] = None,
        temperature: float = 0.3,
        max_tokens: int = 4096,
    ) -> AsyncIterator[str]:
        """Stream a chat response token by token."""
        ...

    def _build_headers(self) -> Dict[str, str]:
        return {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }

    def _resolve_model(self, model: Optional[str]) -> str:
        return model or self.default_model


# ============================================================
# OpenAI Provider
# ============================================================

class OpenAIProvider(ModelProvider):
    """OpenAI-compatible provider (GPT-4o, GPT-4o-mini, etc.)."""

    async def chat(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        model: Optional[str] = None,
        temperature: float = 0.3,
        max_tokens: int = 4096,
    ) -> ChatResponse:
        payload = {
            "model": self._resolve_model(model),
            "messages": [m.to_openai() for m in messages],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if tools:
            payload["tools"] = [t.to_openai() for t in tools]
            payload["tool_choice"] = "auto"

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{self.api_base}/chat/completions",
                headers=self._build_headers(),
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()

        return self._parse_response(data)

    async def chat_stream(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        model: Optional[str] = None,
        temperature: float = 0.3,
        max_tokens: int = 4096,
    ) -> AsyncIterator[str]:
        payload = {
            "model": self._resolve_model(model),
            "messages": [m.to_openai() for m in messages],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": True,
        }
        if tools:
            payload["tools"] = [t.to_openai() for t in tools]
            payload["tool_choice"] = "auto"

        async with httpx.AsyncClient(timeout=180) as client:
            async with client.stream(
                "POST",
                f"{self.api_base}/chat/completions",
                headers=self._build_headers(),
                json=payload,
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if line.startswith("data: "):
                        data_str = line[6:]
                        if data_str == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data_str)
                            delta = chunk["choices"][0].get("delta", {})
                            if "content" in delta and delta["content"]:
                                yield delta["content"]
                        except (json.JSONDecodeError, KeyError, IndexError):
                            continue

    def _parse_response(self, data: Dict[str, Any]) -> ChatResponse:
        choice = data["choices"][0]
        message = choice.get("message", {})

        content = message.get("content")
        tool_calls = None

        if "tool_calls" in message:
            tool_calls = [
                ToolCall(
                    id=tc["id"],
                    name=tc["function"]["name"],
                    arguments=json.loads(tc["function"]["arguments"]),
                )
                for tc in message["tool_calls"]
            ]

        return ChatResponse(
            content=content,
            tool_calls=tool_calls,
            finish_reason=choice.get("finish_reason", "stop"),
            usage=data.get("usage", {}),
            model=data.get("model", ""),
        )


# ============================================================
# Anthropic (Claude) Provider
# ============================================================

class AnthropicProvider(ModelProvider):
    """Anthropic Claude provider with tool-use support."""

    async def chat(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        model: Optional[str] = None,
        temperature: float = 0.3,
        max_tokens: int = 4096,
    ) -> ChatResponse:
        payload = {
            "model": self._resolve_model(model),
            "max_tokens": max_tokens,
            "messages": self._to_anthropic_messages(messages),
        }
        if tools:
            payload["tools"] = self._to_anthropic_tools(tools)

        # Extract system message
        system_msgs = [m for m in messages if m.role == Role.SYSTEM]
        if system_msgs:
            payload["system"] = system_msgs[0].content

        headers = {
            "Content-Type": "application/json",
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
        }

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{self.api_base}/messages",
                headers=headers,
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()

        return self._parse_response(data)

    async def chat_stream(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        model: Optional[str] = None,
        temperature: float = 0.3,
        max_tokens: int = 4096,
    ) -> AsyncIterator[str]:
        payload = {
            "model": self._resolve_model(model),
            "max_tokens": max_tokens,
            "messages": self._to_anthropic_messages(messages),
            "stream": True,
        }
        if tools:
            payload["tools"] = self._to_anthropic_tools(tools)

        system_msgs = [m for m in messages if m.role == Role.SYSTEM]
        if system_msgs:
            payload["system"] = system_msgs[0].content

        headers = {
            "Content-Type": "application/json",
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
        }

        async with httpx.AsyncClient(timeout=180) as client:
            async with client.stream(
                "POST",
                f"{self.api_base}/messages",
                headers=headers,
                json=payload,
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if line.startswith("data: "):
                        data_str = line[6:]
                        try:
                            chunk = json.loads(data_str)
                            if chunk.get("type") == "content_block_delta":
                                delta = chunk.get("delta", {})
                                if delta.get("type") == "text_delta":
                                    yield delta.get("text", "")
                        except (json.JSONDecodeError, KeyError):
                            continue

    def _to_anthropic_messages(self, messages: List[Message]) -> List[Dict]:
        """Convert unified messages to Anthropic format."""
        result = []
        for m in messages:
            if m.role == Role.SYSTEM:
                continue  # Handled separately
            if m.role == Role.USER:
                result.append({"role": "user", "content": m.content or ""})
            elif m.role == Role.ASSISTANT:
                entry: Dict[str, Any] = {"role": "assistant"}
                if m.content:
                    entry["content"] = m.content
                if m.tool_calls:
                    entry["content"] = [
                        {
                            "type": "tool_use",
                            "id": tc.id,
                            "name": tc.name,
                            "input": tc.arguments,
                        }
                        for tc in m.tool_calls
                    ]
                result.append(entry)
            elif m.role == Role.TOOL:
                result.append({
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": m.tool_call_id or "",
                            "content": m.content or "",
                        }
                    ],
                })
        return result

    def _to_anthropic_tools(self, tools: List[ToolDefinition]) -> List[Dict]:
        return [
            {
                "name": t.name,
                "description": t.description,
                "input_schema": t.parameters,
            }
            for t in tools
        ]

    def _parse_response(self, data: Dict[str, Any]) -> ChatResponse:
        content = ""
        tool_calls = []

        for block in data.get("content", []):
            if block.get("type") == "text":
                content += block.get("text", "")
            elif block.get("type") == "tool_use":
                tool_calls.append(ToolCall(
                    id=block.get("id", ""),
                    name=block.get("name", ""),
                    arguments=block.get("input", {}),
                ))

        return ChatResponse(
            content=content or None,
            tool_calls=tool_calls if tool_calls else None,
            finish_reason=data.get("stop_reason", "end_turn"),
            usage={
                "input": data.get("usage", {}).get("input_tokens", 0),
                "output": data.get("usage", {}).get("output_tokens", 0),
            },
            model=data.get("model", ""),
        )


# ============================================================
# Provider Factory — The Model Grabber
# ============================================================

class ModelRegistry:
    """
    Central registry for model providers.

    This is the "model grabber" — it resolves which provider to use
    based on configuration and instantiates the right adapter.

    用法:
        registry = ModelRegistry(config)
        provider = registry.get_provider("openai")  # or "anthropic", "deepseek"
        response = await provider.chat(messages, tools)
    """

    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self._providers: Dict[str, ModelProvider] = {}
        self._init_providers()

    def _init_providers(self):
        """Initialize all configured providers."""
        providers_cfg = self.config.get("models", {}).get("providers", {})

        for name, cfg in providers_cfg.items():
            api_key = self._resolve_env(cfg.get("api_key", ""))
            api_base = cfg.get("api_base", "")
            default_model = cfg.get("default_model", "")

            if not api_key:
                print(f"[ModelRegistry] Skipping '{name}': no API key")
                continue

            # All OpenAI-compatible providers
            openai_compat = {
                "openai", "deepseek", "hunyuan",
                "siliconflow", "groq", "zhipu", "bailian", "volcengine",
            }

            if name in ("anthropic",):
                self._providers[name] = AnthropicProvider(api_key, api_base, default_model)
            elif name in openai_compat:
                self._providers[name] = OpenAIProvider(api_key, api_base, default_model)
            else:
                # Generic fallback — try OpenAI-compatible
                self._providers[name] = OpenAIProvider(api_key, api_base, default_model)

        if not self._providers:
            print("[ModelRegistry] WARNING: No providers configured! Set API key env vars.")

    def _resolve_env(self, value: str) -> str:
        """Resolve ${ENV_VAR} patterns in config values."""
        if value.startswith("${") and value.endswith("}"):
            return os.environ.get(value[2:-1], "")
        return value

    def get_provider(self, name: Optional[str] = None) -> Optional[ModelProvider]:
        """Get a provider by name, or the default one."""
        if name and name in self._providers:
            return self._providers[name]

        default = self.config.get("models", {}).get("default_provider", "")
        if default in self._providers:
            return self._providers[default]

        # Return first available
        if self._providers:
            return next(iter(self._providers.values()))

        return None

    def list_providers(self) -> List[str]:
        return list(self._providers.keys())

    def list_all_models(self) -> List[Dict[str, Any]]:
        """List all configured providers with their models and availability."""
        providers_cfg = self.config.get("models", {}).get("providers", {})
        default_provider = self.config.get("models", {}).get("default_provider", "")
        result = []

        for name, cfg in providers_cfg.items():
            # Skip voice/special providers
            if name in ("doubao_voice",):
                continue

            api_key = self._resolve_env(cfg.get("api_key", ""))
            is_available = name in self._providers
            is_default = name == default_provider

            models = []
            for m in cfg.get("models", []):
                models.append({
                    "id": m,
                    "name": m,
                })

            result.append({
                "id": name,
                "name": cfg.get("display_name", name),
                "api_base": cfg.get("api_base", ""),
                "default_model": cfg.get("default_model", ""),
                "models": models,
                "available": is_available,
                "is_default": is_default,
            })

        return result


# ============================================================
# Utility: prompt resolution
# ============================================================

def resolve_env_vars(config: Dict[str, Any]) -> Dict[str, Any]:
    """Recursively resolve ${VAR} in config dict."""
    if isinstance(config, dict):
        return {k: resolve_env_vars(v) for k, v in config.items()}
    if isinstance(config, list):
        return [resolve_env_vars(v) for v in config]
    if isinstance(config, str):
        pattern = re.compile(r'\$\{([^}]+)\}')
        return pattern.sub(lambda m: os.environ.get(m.group(1), m.group(0)), config)
    return config
