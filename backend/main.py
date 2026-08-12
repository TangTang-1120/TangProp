"""
TangProp Backend — FastAPI Server

启动: python main.py
启动后访问: http://localhost:8080/docs (Swagger UI)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

import uvicorn
import yaml
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from models.adapter import (
    ModelRegistry,
    resolve_env_vars,
    Message,
    Role,
)
from agent.tools import create_default_tools, ToolRegistry

# Workbench 专用：禁用工具，避免模型去 bash/读文件而不是直接输出 HTML
_workbench_tools = ToolRegistry()
from agent.memory import MemoryManager
from agent.loop import AgentLoop, AgentConfig, AgentStatus

# ============================================================
# Configuration
# ============================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("tangprop")

CONFIG_DIR = Path(__file__).parent / "config"


def load_dotenv():
    """Minimal .env loader — no external dependency."""
    env_path = Path(__file__).parent / ".env"
    if not env_path.exists():
        return
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip().strip("\"'")
            if key not in os.environ:
                os.environ[key] = value


def strip_local_proxy_env() -> None:
    """
    清除本地 HTTP 代理环境变量。
    Cursor / Clash 等常注入 127.0.0.1 代理，导致豆包、Pollinations 请求 403。
    后端启动时统一剥离，无需用户手动 unset HTTP_PROXY。
    """
    stripped = []
    for k in list(os.environ.keys()):
        if k.lower() in ("http_proxy", "https_proxy", "all_proxy"):
            stripped.append(f"{k}={os.environ[k]}")
            del os.environ[k]
    if stripped:
        logger.info(f"已忽略本地 HTTP 代理: {', '.join(stripped)}")


def load_config() -> dict:
    """Load and resolve configuration."""
    config_path = CONFIG_DIR / "default.yaml"
    if not config_path.exists():
        logger.warning(f"Config not found: {config_path}, using defaults")
        return {"models": {"default_provider": "openai", "providers": {}}}

    with open(config_path) as f:
        config = yaml.safe_load(f)
    return resolve_env_vars(config)


def load_system_prompt() -> str:
    """Load system prompt from file."""
    prompt_path = CONFIG_DIR / "system_prompt.txt"
    if prompt_path.exists():
        return prompt_path.read_text(encoding="utf-8")
    return "You are TangProp, a powerful AI assistant."


# ============================================================
# Application State
# ============================================================

class AppState:
    """Global application state."""
    def __init__(self):
        self.config = load_config()
        self.model_registry = ModelRegistry(self.config)
        self.workspace_root = os.getcwd()

        # Get default provider
        self.provider = self.model_registry.get_provider()
        if not self.provider:
            logger.warning(
                "No model providers configured. Set OPENAI_API_KEY or "
                "ANTHROPIC_API_KEY environment variable."
            )

        # Tool registry
        self.tools = create_default_tools(workspace=self.workspace_root)

        # Memory
        self.memory = MemoryManager(workspace_root=self.workspace_root)

        # System prompt
        self.system_prompt = load_system_prompt()

        logger.info(f"WorkBuddy ready. Providers: {self.model_registry.list_providers()}")
        logger.info(f"Tools: {self.tools.list_tools()}")
        logger.info(f"Workspace: {self.workspace_root}")


state: Optional[AppState] = None


# ============================================================
# FastAPI App
# ============================================================

# Load .env before anything else
load_dotenv()
strip_local_proxy_env()

@asynccontextmanager
async def lifespan(app: FastAPI):
    global state
    state = AppState()
    yield


app = FastAPI(
    title="TangProp API",
    description="TangProp AI Assistant Backend — Agent Loop + Tools + Memory",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = Path(__file__).parent / "static"
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ============================================================
# API Models
# ============================================================

class ChatRequest(BaseModel):
    message: str = Field(..., description="User message")
    provider: Optional[str] = Field(None, description="Model provider to use")
    model: Optional[str] = Field(None, description="Specific model name")
    max_turns: int = Field(30, ge=1, le=50, description="Max agent turns")
    max_tokens: int = Field(16384, ge=256, le=32768, description="Max tokens per model call")
    temperature: float = Field(0.3, ge=0.0, le=1.0)
    images: Optional[List[str]] = Field(None, description="Base64-encoded images (data URLs)")
    system_context: Optional[str] = Field(None, description="Extra system instructions (e.g. expert persona)")
    expert_prefill: Optional[str] = Field(None, description="Assistant prefill to force structured expert openings")


def _build_system_prompt(base: str, extra: Optional[str]) -> str:
    if not extra or not extra.strip():
        return base
    extra = extra.strip()
    if "专家身份" in extra:
        return extra
    return f"{base}\n\n---\n\n# 当前会话专家指令（优先级高于上文，必须严格执行）\n{extra}"


class ChatResponse(BaseModel):
    response: str
    turns: int
    status: str
    step_log: Optional[str] = None


class ToolInfo(BaseModel):
    name: str
    description: str


class MemoryInfo(BaseModel):
    user_rules: Optional[str] = None
    project_notes: Optional[str] = None


# ============================================================
# Routes
# ============================================================

@app.get("/")
async def root():
    tangprop_path = FRONTEND_DIR / "tangprop.html"
    if tangprop_path.exists():
        return FileResponse(str(tangprop_path), media_type="text/html; charset=utf-8")
    index_path = STATIC_DIR / "index.html"
    if index_path.exists():
        return FileResponse(str(index_path))
    return {
        "name": "TangProp API",
        "version": "1.0.0",
        "providers": state.model_registry.list_providers() if state else [],
        "tools": state.tools.list_tools() if state else [],
        "status": "ready" if state and state.provider else "unconfigured",
    }


@app.get("/tangprop.html")
async def tangprop_page():
    """前端单页应用入口。"""
    path = FRONTEND_DIR / "tangprop.html"
    if not path.exists():
        raise HTTPException(status_code=404, detail="tangprop.html not found")
    return FileResponse(str(path), media_type="text/html; charset=utf-8")




@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    """Send a message to WorkBuddy and get a response."""
    if not state or not state.provider:
        raise HTTPException(
            status_code=503,
            detail="No model provider configured. Set OPENAI_API_KEY env var.",
        )

    # Select provider
    provider = state.model_registry.get_provider(req.provider) or state.provider

    # Create agent for this request
    agent_config = AgentConfig(
        max_turns=req.max_turns,
        max_tokens=req.max_tokens,
        temperature=req.temperature,
        workspace_root=state.workspace_root,
        system_prompt=_build_system_prompt(state.system_prompt, req.system_context),
    )

    agent = AgentLoop(
        provider=provider,
        tools=state.tools,
        memory=state.memory,
        config=agent_config,
        model=req.model,
    )

    logger.info(f"Chat request: '{req.message[:80]}...'")
    response = await agent.run(req.message)

    return ChatResponse(
        response=response,
        turns=agent.turn_count,
        status=agent.status.value,
        step_log=agent.get_step_log() if agent.turn_count > 1 else None,
    )


FREE_PROVIDER_ORDER = ("volcengine", "zhipu", "siliconflow")


def _model_for_provider(provider_id: str, requested: Optional[str] = None) -> str:
    """Pick a valid model id for provider; ignore cross-provider model names."""
    cfg = state.model_registry.config.get("models", {}).get("providers", {}).get(provider_id, {})
    allowed = cfg.get("models") or []
    if requested and requested in allowed:
        return requested
    if cfg.get("default_model"):
        return cfg["default_model"]
    return allowed[0] if allowed else (requested or "")


def _chat_provider_candidates(req: ChatRequest):
    """Build primary + free fallback provider list (free providers only)."""
    candidates = []
    seen = set()
    available = set(state.model_registry.list_providers())

    req_pid = req.provider if req.provider in FREE_PROVIDER_ORDER and req.provider in available else None
    if req_pid:
        prov = state.model_registry.get_provider(req_pid)
        if prov:
            seen.add(id(prov))
            candidates.append((prov, _model_for_provider(req_pid, req.model), req_pid))

    for pid in FREE_PROVIDER_ORDER:
        if pid not in available:
            continue
        prov = state.model_registry.get_provider(pid)
        if prov and id(prov) not in seen:
            seen.add(id(prov))
            candidates.append((prov, _model_for_provider(pid, None), pid))
    return candidates


def _is_expert_session(req: ChatRequest) -> bool:
    return bool(req.system_context and "专家身份" in req.system_context)


async def _stream_expert_direct(provider, model, req: ChatRequest):
    """Expert mode: direct model stream, no tools / agent loop."""
    system = _build_system_prompt(state.system_prompt, req.system_context)
    messages = [
        Message(role=Role.SYSTEM, content=system),
        Message(role=Role.USER, content=req.message),
    ]
    if req.expert_prefill and req.expert_prefill.strip():
        messages.append(Message(role=Role.ASSISTANT, content=req.expert_prefill.strip()))
    yield json.dumps({"type": "status", "status": "thinking", "turn": 1}) + "\n"
    streamed = False
    async for event in provider.chat_stream(
        messages=messages,
        tools=None,
        model=model,
        temperature=req.temperature,
        max_tokens=req.max_tokens,
    ):
        evt_type = event.get("type")
        if evt_type == "text":
            token = event.get("content", "")
            if not token:
                continue
            if not streamed:
                yield json.dumps({"type": "text_start"}) + "\n"
                streamed = True
            yield json.dumps({"type": "text", "content": token}) + "\n"
        elif evt_type == "error":
            yield json.dumps({"type": "error", "message": event.get("message", "模型请求失败")}) + "\n"
            return
    if streamed:
        yield json.dumps({"type": "text_end"}) + "\n"


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    """Stream a WorkBuddy response."""
    if not state or not state.provider:
        raise HTTPException(status_code=503, detail="No model provider configured.")

    expert_mode = _is_expert_session(req)

    def _build_agent(provider, model):
        agent_config = AgentConfig(
            max_turns=min(req.max_turns, 2) if expert_mode else req.max_turns,
            max_tokens=req.max_tokens,
            temperature=req.temperature,
            workspace_root=state.workspace_root,
            system_prompt=_build_system_prompt(state.system_prompt, req.system_context),
            disable_tools=expert_mode,
        )
        return AgentLoop(
            provider=provider,
            tools=state.tools,
            memory=state.memory,
            config=agent_config,
            model=model,
        )

    candidates = _chat_provider_candidates(req)

    async def generate():
        last_error = "模型请求失败"
        for idx, (provider, model, label) in enumerate(candidates):
            if idx > 0:
                yield json.dumps({
                    "type": "status",
                    "status": "thinking",
                    "turn": 1,
                    "note": f"主模型不可用，已切换 {label}",
                }) + "\n"
            agent = _build_agent(provider, model)
            got_text = False
            stream_failed = False
            try:
                stream_fn = _stream_expert_direct if expert_mode else agent.run_stream
                stream_args = (provider, model, req) if expert_mode else (req.message,)
                async for chunk in stream_fn(*stream_args):
                    try:
                        ev = json.loads(chunk.strip())
                        if ev.get("type") in ("text", "text_start"):
                            got_text = True
                        elif ev.get("type") == "error":
                            last_error = ev.get("message") or last_error
                            if not got_text and idx < len(candidates) - 1:
                                stream_failed = True
                                break
                    except json.JSONDecodeError:
                        got_text = True
                    yield chunk
                if got_text and not stream_failed:
                    return
            except asyncio.CancelledError:
                logger.info("Stream cancelled by client")
                raise
            except Exception as e:
                logger.warning(f"Stream error on {label}: {e}")
                last_error = str(e)
                if idx < len(candidates) - 1:
                    continue
                yield json.dumps({"type": "error", "message": last_error}) + "\n"
                return

        yield json.dumps({"type": "error", "message": last_error}) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


# ============================================================
# Agent Workbench — 专门为「左侧对话 + 右侧预览」设计的流式端点
# ============================================================

WORKBENCH_SYSTEM_PROMPT = """你是 TangProp 的 Workbench Agent —— 一个能直接产出「可预览」产物的工程师。

# 工作方式
1. 用户会给一个需求（可能是网页、组件、图表、布局、文案、配色等）。
2. 你 **必须** 在回复中输出一段完整的 HTML 代码（包含 <style> 和 <body>），用 ```html ... ``` 围起来，作为右侧预览面板要渲染的内容。
3. 代码块前后可以加简短中文说明（标题、要点、修改建议等），但 **整段代码必须完整可运行** —— 浏览器打开就能看到结果，不能引用外部相对路径（用 https:// 绝对 URL 或内联 SVG）。
4. 设计风格默认走「苹果风」：白底、SF Pro 字体栈、大标题 + 副标题、产品卡片、留白克制、圆角 12–20px、阴影柔和。配色用 #1d1d1f 主文字、#06c 强调色、#f5f5f7 浅灰背景。如果用户指定其他风格，照做。
5. 只输出产物 HTML，不要解释你做了什么、问问题、给多选项。一次给完。
6. 如果用户消息是「重新生成」/「换一个」/「再改一下」，在保留上一版结构的前提下，按指令调整。
7. 整个回复 ≤ 2000 字，代码块尽量精简（< 800 行 HTML）。

# 输出格式（严格）
[可选：一两行简短说明]

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>...</title>
<style>...</style>
</head>
<body>...</body>
</html>
```
"""


class WorkbenchRequest(BaseModel):
    message: str = Field(..., description="User request")
    provider: Optional[str] = Field(None, description="Model provider to use")
    model: Optional[str] = Field(None, description="Specific model name")
    max_tokens: int = Field(16384, ge=256, le=32768)
    temperature: float = Field(0.4, ge=0.0, le=1.0)


@app.post("/workbench/run")
async def workbench_run(req: WorkbenchRequest):
    """Stream a Workbench turn: chat reply + extracted HTML preview block.

    Protocol (NDJSON):
      {type:"status", state:"thinking"}
      {type:"text", delta:"..."}                 ← 流式聊天文本
      {type:"preview_html", html:"..."}          ← 提取到的预览 HTML（完整、最后一条）
      {type:"done"}
      {type:"error", message:"..."}
    """
    if not state or not state.provider:
        raise HTTPException(status_code=503, detail="No model provider configured.")

    provider = state.model_registry.get_provider(req.provider) or state.provider

    agent_config = AgentConfig(
        max_turns=1,                       # 单轮直接生成 HTML，不跑工具循环
        max_tokens=req.max_tokens,
        temperature=req.temperature,
        workspace_root=state.workspace_root,
        system_prompt=WORKBENCH_SYSTEM_PROMPT,
    )
    agent = AgentLoop(
        provider=provider,
        tools=_workbench_tools,
        memory=state.memory,
        config=agent_config,
        model=req.model,
    )

    async def generate():
        try:
            yield (json.dumps({"type": "status", "state": "thinking"}) + "\n")
            full_text_parts: list[str] = []

            async for chunk in agent.run_stream(req.message):
                # 把 AgentLoop 的内部 NDJSON 转成前端 Workbench 协议
                try:
                    obj = json.loads(chunk)
                except Exception:
                    full_text_parts.append(chunk)
                    yield (json.dumps({"type": "text", "delta": chunk}) + "\n")
                    continue

                t = obj.get("type")
                if t == "text":
                    # AgentLoop 内部 text 事件的字段是 "content"（不是 "delta"）
                    delta = obj.get("content") or obj.get("delta") or ""
                    full_text_parts.append(delta)
                    yield (json.dumps({"type": "text", "delta": delta}) + "\n")
                elif t == "text_end":
                    pass  # 等 done 时再统一抽代码块
                elif t == "tool_call":
                    tool_name = obj.get("tool") or obj.get("name") or ""
                    yield (json.dumps({"type": "tool_call", "name": tool_name}) + "\n")
                elif t == "tool_result":
                    tool_name = obj.get("tool") or obj.get("name") or ""
                    yield (json.dumps({"type": "tool_result", "name": tool_name}) + "\n")
                elif t == "status":
                    # AgentLoop status 事件字段是 "status"（不是 "state"）
                    state_val = obj.get("state") or obj.get("status") or "thinking"
                    yield (json.dumps({"type": "status", "state": state_val}) + "\n")
                elif t == "error":
                    yield (json.dumps({"type": "error", "message": obj.get("message", "")}) + "\n")
                else:
                    # 其它类型原样转发
                    yield chunk

            full_text = "".join(full_text_parts)
            html_match = _extract_last_html_block(full_text)
            if html_match:
                yield (json.dumps({"type": "preview_html", "html": html_match}) + "\n")

            yield (json.dumps({"type": "done"}) + "\n")
        except asyncio.CancelledError:
            logger.info("Workbench stream cancelled by client")
            raise
        except Exception as e:
            logger.exception(f"Workbench stream error: {e}")
            try:
                yield (json.dumps({"type": "error", "message": f"stream error: {e}"}) + "\n")
            except Exception:
                pass

    return StreamingResponse(generate(), media_type="application/x-ndjson")


_HTML_FENCE_RE = None  # 延迟编译


def _extract_last_html_block(text: str) -> Optional[str]:
    """从模型回复中抽取最后一段 ```html ... ``` 代码块。"""
    import re
    global _HTML_FENCE_RE
    if _HTML_FENCE_RE is None:
        # 匹配 ```html ... ``` 或裸 ```...```（里面包含 <!DOCTYPE 或 <html>）
        _HTML_FENCE_RE = re.compile(
            r"```(?:html)?\s*\n?(.*?)```",
            re.DOTALL | re.IGNORECASE,
        )
    matches = _HTML_FENCE_RE.findall(text)
    if matches:
        return matches[-1].strip()
    # 兜底：模型未加 markdown 围栏但输出了完整 HTML
    lower = text.lower()
    for marker in ("<!doctype html", "<html"):
        idx = lower.find(marker)
        if idx >= 0:
            snippet = text[idx:]
            end = lower.rfind("</html>")
            if end >= 0:
                return snippet[: end + len("</html>")].strip()
            return snippet.strip()
    return None


class ModelProviderInfo(BaseModel):
    id: str
    name: str
    api_base: str
    default_model: str
    models: list
    available: bool
    is_default: bool


@app.get("/models", response_model=List[ModelProviderInfo])
async def list_models():
    """List all configured model providers and their models."""
    if not state:
        return []
    return state.model_registry.list_all_models()


@app.get("/tools", response_model=List[ToolInfo])
async def list_tools():
    """List all available tools."""
    if not state:
        return []
    defs = state.tools.get_definitions()
    return [ToolInfo(name=d.name, description=d.description) for d in defs]


@app.post("/tools/{tool_name}")
async def execute_tool(tool_name: str, arguments: dict):
    """Execute a tool directly."""
    if not state:
        raise HTTPException(status_code=503, detail="Server not initialized.")
    result = await state.tools.execute(tool_name, arguments)
    return {
        "success": result.success,
        "output": result.output,
        "error": result.error,
        "metadata": result.metadata,
    }


@app.get("/memory", response_model=MemoryInfo)
async def get_memory():
    """Get current memory context."""
    if not state:
        return MemoryInfo()
    ctx = state.memory.get_context()
    return MemoryInfo(
        user_rules=ctx.user_rules,
        project_notes=ctx.workspace_notes,
    )


@app.post("/memory/workspace")
async def save_workspace_note(content: str):
    """Save a note to workspace memory."""
    state.memory.save_project_note(content)
    return {"status": "saved"}


@app.post("/memory/user")
async def save_user_rule(content: str):
    """Save a rule to user memory."""
    state.memory.save_user_rule(content)
    return {"status": "saved"}


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "providers": state.model_registry.list_providers() if state else [],
        "provider_ok": state.provider is not None if state else False,
    }


# ============================================================
# Auth — 手机号 + 短信验证码（腾讯云 SMS）
# ============================================================

import secrets
import time
import random
from datetime import datetime, timedelta

# In-memory session & code store. Replace with Redis/DB in production.
_sessions: dict[str, dict] = {}
_code_store: dict[str, dict] = {}  # phone -> {code, expires_at, sent_count}

# ── 腾讯云 SMS 配置 ──
TENCENT_SMS_SECRET_ID = os.environ.get("TENCENT_SMS_SECRET_ID", "")
TENCENT_SMS_SECRET_KEY = os.environ.get("TENCENT_SMS_SECRET_KEY", "")
TENCENT_SMS_SDK_APP_ID = os.environ.get("TENCENT_SMS_SDK_APP_ID", "")
TENCENT_SMS_SIGN_NAME = os.environ.get("TENCENT_SMS_SIGN_NAME", "TangProp")
TENCENT_SMS_TEMPLATE_ID = os.environ.get("TENCENT_SMS_TEMPLATE_ID", "")

# SMS SDK 实例（延迟初始化）
_sms_client = None

def _get_sms_client():
    """延迟导入腾讯云 SMS SDK，避免未安装时启动报错"""
    global _sms_client
    if _sms_client is not None:
        return _sms_client
    if not TENCENT_SMS_SECRET_ID or not TENCENT_SMS_SECRET_KEY:
        return None
    try:
        from tencentcloud.common import credential
        from tencentcloud.sms.v20210111 import sms_client
        cred = credential.Credential(TENCENT_SMS_SECRET_ID, TENCENT_SMS_SECRET_KEY)
        _sms_client = sms_client.SmsClient(cred, "ap-guangzhou")
        return _sms_client
    except ImportError:
        logger.warning("tencentcloud-sdk-python not installed. Run: pip install tencentcloud-sdk-python")
        return None


def _generate_code() -> str:
    """生成 6 位数字验证码"""
    return f"{random.randint(0, 999999):06d}"


async def _send_tencent_sms(phone: str, code: str) -> tuple[bool, str]:
    """调用腾讯云 SMS 发送验证码。返回 (success, message)"""
    client = _get_sms_client()
    if not client:
        # SDK 未安装或未配置 → 开发模式：打印到控制台
        logger.info(f"[DEV MODE] 验证码: phone={phone}, code={code}")
        return True, f"开发模式：验证码 {code}（未发送真实短信，请配置腾讯云 SMS）"

    try:
        from tencentcloud.sms.v20210111 import models as sms_models
        req = sms_models.SendSmsRequest()
        req.SmsSdkAppId = TENCENT_SMS_SDK_APP_ID
        req.SignName = TENCENT_SMS_SIGN_NAME
        req.TemplateId = TENCENT_SMS_TEMPLATE_ID
        # 模板参数顺序需与腾讯云后台模板一致，通常是 {1}=验证码, {2}=过期分钟数
        req.TemplateParamSet = [code, "5"]
        # 手机号格式：国内需加 +86 前缀
        req.PhoneNumberSet = [f"+86{phone}"]

        resp = client.SendSms(req)
        status = resp.SendStatusSet[0]
        if status.Code == "Ok":
            logger.info(f"SMS sent successfully to {phone}")
            return True, "验证码已发送"
        else:
            logger.error(f"SMS failed: {status.Code} - {status.Message}")
            return False, f"短信发送失败: {status.Message}"
    except Exception as e:
        logger.error(f"SMS exception: {e}")
        return False, f"短信发送异常: {e}"


class SendCodeRequest(BaseModel):
    phone: str = Field(..., pattern=r"^1[3-9]\d{9}$")


class SendCodeResponse(BaseModel):
    success: bool
    message: str
    dev_code: Optional[str] = None  # 仅开发模式返回


class LoginRequest(BaseModel):
    phone: str = Field(..., pattern=r"^1[3-9]\d{9}$")
    code: str = Field(..., min_length=4, max_length=6)


class EmailSendCodeRequest(BaseModel):
    email: str = Field(..., pattern=r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$")


class EmailLoginRequest(BaseModel):
    email: str = Field(..., pattern=r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$")
    code: str = Field(..., min_length=4, max_length=6)


class LoginResponse(BaseModel):
    success: bool
    user: Optional[dict] = None
    token: Optional[str] = None
    error: Optional[str] = None


class UserProfile(BaseModel):
    id: str
    phone: Optional[str] = ""
    email: Optional[str] = ""
    name: str
    plan: str
    created_at: str
    avatar: Optional[str] = ""


def _generate_token() -> str:
    return secrets.token_urlsafe(32)


@app.post("/auth/send-code", response_model=SendCodeResponse)
async def send_code(req: SendCodeRequest):
    """发送短信验证码。腾讯云 SMS 未配置时自动降级为开发模式（验证码返回到响应中）。"""
    phone = req.phone

    # 频率限制：60 秒内不可重复发送
    existing = _code_store.get(phone)
    if existing and time.time() < existing["expires_at"] - 240:
        remaining = int(existing["expires_at"] - 240 - time.time())
        raise HTTPException(status_code=429, detail=f"发送太频繁，请 {remaining} 秒后重试")

    code = _generate_code()
    _code_store[phone] = {
        "code": code,
        "expires_at": time.time() + 300,  # 5 分钟有效
    }

    success, message = await _send_tencent_sms(phone, code)

    resp = SendCodeResponse(success=success, message=message)
    # 开发模式（未配置腾讯云）返回验证码方便调试
    if not TENCENT_SMS_SECRET_ID:
        resp.dev_code = code
    return resp


@app.post("/auth/login", response_model=LoginResponse)
async def login(req: LoginRequest):
    """登录：验证手机号 + 短信验证码。"""
    phone = req.phone
    stored = _code_store.get(phone)

    if not stored:
        raise HTTPException(status_code=400, detail="请先获取验证码")

    if time.time() > stored["expires_at"]:
        _code_store.pop(phone, None)
        raise HTTPException(status_code=410, detail="验证码已过期，请重新获取")

    if req.code != stored["code"]:
        raise HTTPException(status_code=401, detail="验证码错误")

    # 验证通过，清除验证码
    _code_store.pop(phone, None)

    user_id = f"u_{phone}"
    token = _generate_token()
    _sessions[token] = {
        "user_id": user_id,
        "phone": phone,
        "name": phone,
        "plan": "体验版",
        "created_at": datetime.now().isoformat(),
        "expires_at": (datetime.now() + timedelta(days=7)).isoformat(),
    }

    return LoginResponse(
        success=True,
        user={
            "id": user_id,
            "phone": phone,
            "name": phone,
            "plan": "体验版",
        },
        token=token,
    )


# ── 邮箱验证码登录 ──

# SMTP 配置
SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "465"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")  # 授权码，不是登录密码
SMTP_FROM_NAME = os.environ.get("SMTP_FROM_NAME", "TangProp")

# 邮箱验证码存储: email -> {code, expires_at}
_email_code_store: dict[str, dict] = {}


async def _send_email_code(email: str, code: str) -> tuple[bool, str]:
    """发送邮箱验证码。SMTP 未配置时进入开发模式。"""
    if not SMTP_HOST or not SMTP_USER:
        logger.info(f"[DEV MODE] 邮箱验证码: email={email}, code={code}")
        return True, f"开发模式：验证码 {code}（未配置 SMTP，未真实发送邮件）"

    try:
        import smtplib
        from email.mime.text import MIMEText
        from email.mime.multipart import MIMEMultipart

        msg = MIMEMultipart("alternative")
        msg["From"] = f"{SMTP_FROM_NAME} <{SMTP_USER}>"
        msg["To"] = email
        msg["Subject"] = f"【TangProp】邮箱验证码 {code}"

        html_body = f"""
        <div style="max-width:480px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
          <div style="background:linear-gradient(135deg,#52B6FB,#8FCEFD);padding:32px 24px;border-radius:12px 12px 0 0;text-align:center;">
            <div style="width:48px;height:48px;background:#fff;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;color:#52B6FB;">T</div>
            <h2 style="color:#fff;margin:12px 0 0;">TangProp</h2>
          </div>
          <div style="background:#fff;padding:32px 24px;border:1px solid #e8e8e8;border-top:none;">
            <p style="color:#333;font-size:15px;">您正在登录 TangProp，验证码为：</p>
            <div style="text-align:center;margin:24px 0;">
              <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:#52B6FB;">{code}</span>
            </div>
            <p style="color:#999;font-size:13px;">验证码 5 分钟内有效，请勿向他人泄露。</p>
          </div>
          <p style="text-align:center;color:#ccc;font-size:12px;margin-top:16px;">此邮件由系统自动发送，请勿回复</p>
        </div>
        """
        msg.attach(MIMEText(html_body, "html", "utf-8"))

        if SMTP_PORT == 465:
            server = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=15)
        else:
            server = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15)
            server.starttls()

        server.login(SMTP_USER, SMTP_PASSWORD)
        server.sendmail(SMTP_USER, [email], msg.as_string())
        server.quit()

        logger.info(f"Email code sent to {email}")
        return True, "验证码已发送至邮箱"
    except Exception as e:
        logger.error(f"Email send failed: {e}")
        return False, f"邮件发送失败: {e}"


@app.post("/auth/send-email-code", response_model=SendCodeResponse)
async def send_email_code(req: EmailSendCodeRequest):
    """发送邮箱验证码。SMTP 未配置时自动降级为开发模式。"""
    email = req.email

    # 频率限制
    existing = _email_code_store.get(email)
    if existing and time.time() < existing["expires_at"] - 240:
        remaining = int(existing["expires_at"] - 240 - time.time())
        raise HTTPException(status_code=429, detail=f"发送太频繁，请 {remaining} 秒后重试")

    code = _generate_code()
    _email_code_store[email] = {
        "code": code,
        "expires_at": time.time() + 300,
    }

    success, message = await _send_email_code(email, code)

    resp = SendCodeResponse(success=success, message=message)
    if not SMTP_HOST:
        resp.dev_code = code
    return resp


@app.post("/auth/email-login", response_model=LoginResponse)
async def email_login(req: EmailLoginRequest):
    """邮箱 + 验证码登录。"""
    email = req.email
    stored = _email_code_store.get(email)

    if not stored:
        raise HTTPException(status_code=400, detail="请先获取验证码")

    if time.time() > stored["expires_at"]:
        _email_code_store.pop(email, None)
        raise HTTPException(status_code=410, detail="验证码已过期，请重新获取")

    if req.code != stored["code"]:
        raise HTTPException(status_code=401, detail="验证码错误")

    _email_code_store.pop(email, None)

    user_id = f"u_{email}"
    token = _generate_token()
    _sessions[token] = {
        "user_id": user_id,
        "email": email,
        "name": email.split("@")[0],
        "plan": "体验版",
        "created_at": datetime.now().isoformat(),
        "expires_at": (datetime.now() + timedelta(days=7)).isoformat(),
    }

    return LoginResponse(
        success=True,
        user={
            "id": user_id,
            "email": email,
            "name": email.split("@")[0],
            "plan": "体验版",
        },
        token=token,
    )


@app.get("/auth/me", response_model=UserProfile)
async def me(token: str):
    """Get current user profile by token."""
    sess = _sessions.get(token)
    if not sess:
        raise HTTPException(status_code=401, detail="未登录或登录已过期")
    return UserProfile(
        id=sess["user_id"],
        phone=sess.get("phone", ""),
        email=sess.get("email", ""),
        name=sess["name"],
        plan=sess["plan"],
        created_at=sess["created_at"],
        avatar=sess.get("avatar", ""),
    )


@app.post("/auth/logout")
async def logout(token: str):
    """Logout and invalidate token."""
    _sessions.pop(token, None)
    return {"success": True}


class UpdateProfileRequest(BaseModel):
    token: str
    name: Optional[str] = None
    avatar: Optional[str] = None  # emoji or single char


@app.post("/auth/update-profile")
async def update_profile(req: UpdateProfileRequest):
    """Update user display name and avatar."""
    sess = _sessions.get(req.token)
    if not sess:
        raise HTTPException(status_code=401, detail="未登录或登录已过期")
    if req.name is not None:
        name = req.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="昵称不能为空")
        if len(name) > 20:
            raise HTTPException(status_code=400, detail="昵称最多 20 个字符")
        sess["name"] = name
    if req.avatar is not None:
        avatar = req.avatar.strip()
        # 支持 data URL 图片头像（最大 2MB base64）或文字头像（最长 10 字符）
        if avatar.startswith('data:image/'):
            if len(avatar) > 3 * 1024 * 1024:
                raise HTTPException(status_code=400, detail="头像图片不能超过 2MB")
        else:
            if len(avatar) > 10:
                raise HTTPException(status_code=400, detail="头像格式不正确")
        sess["avatar"] = avatar
    return {"success": True, "user": {
        "id": sess["user_id"],
        "phone": sess.get("phone", ""),
        "name": sess["name"],
        "plan": sess["plan"],
        "avatar": sess.get("avatar", ""),
        "created_at": sess["created_at"],
    }}


# ============================================================
# Image Generation — 豆包 doubao_image (推荐) + Pollinations.ai (零门槛) + 硅基流动 (备选)
# ============================================================

import httpx
import base64
import urllib.parse

SILICONFLOW_API_KEY = os.environ.get("SILICONFLOW_API_KEY", "")
SILICONFLOW_IMG_BASE = "https://api.siliconflow.cn/v1/images/generations"

# 豆包文生图（火山方舟 Seedream）— 复用 VOLCENGINE_API_KEY / ARK_API_KEY
# model 字段可为推理接入点 ep-xxx，或模型 ID（如 doubao-seedream-4-0-250828）
DOUBAO_IMG_BASE = "https://ark.cn-beijing.volces.com/api/v3/images/generations"
DOUBAO_DEFAULT_ENDPOINT = os.environ.get(
    "DOUBAO_IMG_ENDPOINT", "doubao-seedream-4-0-250828"
)


def _volcengine_api_key() -> str:
    return os.environ.get("VOLCENGINE_API_KEY") or os.environ.get("ARK_API_KEY") or ""

# Pollinations.ai — 完全免费，flux 免 Key；turbo 走 legacy 端点
POLLINATIONS_GEN_BASE = "https://gen.pollinations.ai/image/"
POLLINATIONS_LEGACY_BASE = "https://image.pollinations.ai/p/"
POLLINATIONS_API_KEY = os.environ.get("POLLINATIONS_API_KEY", "")

# 可用模型列表（前端 /image/models 与生成逻辑共用）
IMAGE_MODELS = {
    "zimage": "Z-Image (Pollinations 免费, 艺术风格)",
    "flux": "Flux (Pollinations 免费, 写实)",
    "turbo": "Turbo (Pollinations 免费, 快速)",
    "doubao:seedream-4": "豆包 Seedream 4 (火山方舟, 免费500次)",
    "doubao:seedream-3": "豆包 Seedream 3 (火山方舟, 免费500次)",
}

# Pollinations legacy 模型映射（无 Key 时 gen 端点需认证，走 legacy）
POLLINATIONS_LEGACY_MODEL_MAP = {
    "flux": "flux",
    "zimage": "flux",
    "turbo": "turbo",
}


def _get_image_config() -> dict:
    """从 default.yaml 读取 image 配置（启动后可用）。"""
    try:
        cfg = load_config()
        return cfg.get("image") or {}
    except Exception:
        return {}


def _pollinations_gen_url(prompt: str, w: int, h: int, gen_model: str = "flux") -> str:
    encoded = urllib.parse.quote(prompt, safe="")
    seed = random.randint(1, 999999)
    url = (
        f"{POLLINATIONS_GEN_BASE}{encoded}"
        f"?model={urllib.parse.quote(gen_model, safe='')}"
        f"&width={w}&height={h}&seed={seed}&nologo=true"
    )
    if POLLINATIONS_API_KEY:
        url += f"&key={urllib.parse.quote(POLLINATIONS_API_KEY)}"
    return url


def _pollinations_legacy_url(prompt: str, w: int, h: int, legacy_model: str = "turbo") -> str:
    encoded = urllib.parse.quote(prompt, safe="")
    seed = random.randint(1, 999999)
    return (
        f"{POLLINATIONS_LEGACY_BASE}{encoded}"
        f"?width={w}&height={h}&model={legacy_model}&nologo=true&seed={seed}"
    )


POLLINATIONS_HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
}


def _curl_get_sync(url: str, timeout: float = 90.0) -> tuple[int, bytes, str]:
    """curl 直连 GET，用于 Pollinations 图片代理。"""
    cmd = [_curl_bin(), "-sS", "--noproxy", "*", "--max-time", str(int(timeout)), url]
    proc = subprocess.run(cmd, capture_output=True, env=_no_proxy_env(), check=False)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or b"").decode(errors="replace").strip())
    data = proc.stdout or b""
    return 200, data, "image/jpeg"


async def _pollinations_fetch(url: str, timeout: float = 90.0, **kwargs) -> httpx.Response:
    """
    拉取 Pollinations 图片。本地 HTTP 代理常对 image.pollinations.ai 返回 403，
    因此先直连（trust_env=False），失败再尝试系统代理。
    """
    last_exc: Exception | None = None
    for trust_env in (False, True):
        try:
            async with httpx.AsyncClient(
                timeout=timeout,
                follow_redirects=True,
                headers=POLLINATIONS_HTTP_HEADERS,
                trust_env=trust_env,
            ) as client:
                resp = await client.get(url, **kwargs)
            if resp.status_code < 400 or resp.status_code == 403:
                return resp
            if trust_env:
                return resp
        except httpx.ProxyError as e:
            last_exc = e
            logger.warning(f"Pollinations fetch via proxy failed: {e}")
            continue
        except Exception as e:
            last_exc = e
            if trust_env:
                raise
            logger.warning(f"Pollinations direct fetch failed: {e}")
            continue
    if last_exc:
        raise last_exc
    raise RuntimeError("Pollinations fetch failed")


async def _verify_image_url(url: str, timeout: float = 25.0) -> bool:
    """HEAD 探测 URL 是否可访问（失败时不阻塞，由前端 img onerror 兜底）。"""
    try:
        async with httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            headers=POLLINATIONS_HTTP_HEADERS,
            trust_env=False,
        ) as client:
            resp = await client.head(url)
            if resp.status_code < 400:
                return True
            resp = await client.get(url, headers={"Range": "bytes=0-0"})
            if resp.status_code in (200, 206):
                return True
        resp = await _pollinations_fetch(url, timeout=timeout, headers={"Range": "bytes=0-0"})
        return resp.status_code in (200, 206)
    except Exception as e:
        logger.warning(f"Pollinations URL verify failed: {e}")
        return False


async def _resolve_pollinations_image(prompt: str, w: int, h: int, model_key: str) -> tuple[str, str, str]:
    """
    返回 (image_url, resolved_model, provider_label)。
    无 Key：走 legacy image.pollinations.ai（浏览器可直连）；
    有 Key：优先 gen.pollinations.ai。
    """
    legacy_model = POLLINATIONS_LEGACY_MODEL_MAP.get(model_key, "flux")

    if POLLINATIONS_API_KEY:
        gen_model = {"flux": "flux", "zimage": "zimage", "turbo": "zimage"}.get(model_key, "zimage")
        gen_url = _pollinations_gen_url(prompt, w, h, gen_model)
        if await _verify_image_url(gen_url, timeout=45):
            return gen_url, gen_model, "pollinations"

    legacy_url = _pollinations_legacy_url(prompt, w, h, legacy_model)
    return legacy_url, legacy_model, "pollinations"


class ImageGenerateRequest(BaseModel):
    prompt: str = Field(..., description="Image generation prompt")
    model: Optional[str] = Field(None, description="Pollinations model: flux (default) or turbo")
    image_size: str = Field("1024x1024", description="Image size: 1024x1024, 1280x720, 768x1024")


class ImageGenerateResponse(BaseModel):
    success: bool
    image_url: Optional[str] = None
    model: Optional[str] = None
    provider: Optional[str] = None
    error: Optional[str] = None


def _pollinations_url(prompt: str, w: int, h: int, model: str = "flux") -> str:
    """同步构造 URL（兼容旧调用）。"""
    if model == "turbo" and not POLLINATIONS_API_KEY:
        return _pollinations_legacy_url(prompt, w, h, "turbo")
    return _pollinations_gen_url(prompt, w, h, "flux" if model != "turbo" else "zimage")


def _curl_bin() -> str:
    return shutil.which("curl") or "/usr/bin/curl"


def _no_proxy_env() -> dict[str, str]:
    env = os.environ.copy()
    for k in list(env.keys()):
        if k.lower() in ("http_proxy", "https_proxy", "all_proxy"):
            del env[k]
    return env


def _curl_post_json_sync(
    url: str, headers: dict, payload: dict, timeout: float = 90.0
) -> tuple[int, dict]:
    """curl 直连 POST JSON，绕过本地 HTTP 代理。"""
    body = json.dumps(payload, ensure_ascii=False)
    cmd = [
        _curl_bin(), "-sS", "--noproxy", "*", "--max-time", str(int(timeout)),
        "-X", "POST", url,
        "-H", "Content-Type: application/json; charset=utf-8",
    ]
    for k, v in headers.items():
        if k.lower() == "content-type":
            continue
        cmd.extend(["-H", f"{k}: {v}"])
    cmd.extend(["--data-binary", "@-"])
    proc = subprocess.run(
        cmd,
        input=body,
        capture_output=True,
        text=True,
        env=_no_proxy_env(),
        check=False,
    )
    raw = (proc.stdout or proc.stderr or "").strip()
    if proc.returncode != 0:
        raise RuntimeError(raw or f"curl exit {proc.returncode}")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return 502, {"message": raw}
    if isinstance(data.get("error"), dict) and data["error"].get("message"):
        return 400, data
    return 200, data


async def _post_json_with_fallback(
    url: str, headers: dict, payload: dict, timeout: float = 90.0
) -> tuple[int, dict]:
    """POST JSON：火山方舟等优先 curl 直连，失败再试 httpx。"""
    curl_err: Exception | None = None
    try:
        return await asyncio.to_thread(_curl_post_json_sync, url, headers, payload, timeout)
    except Exception as e:
        curl_err = e
        logger.warning(f"curl POST failed: {curl_err}")

    last_err: Exception | None = curl_err
    for trust_env in (False, True):
        try:
            async with httpx.AsyncClient(timeout=timeout, trust_env=trust_env) as client:
                resp = await client.post(url, headers=headers, json=payload)
            try:
                data = resp.json()
            except Exception:
                data = {"message": resp.text}
            if resp.status_code < 400:
                return resp.status_code, data
            last_err = RuntimeError(f"HTTP {resp.status_code}")
        except Exception as e:
            last_err = e
    raise RuntimeError(str(last_err or "request failed"))


DOUBAO_MODEL_MAP = {
    "doubao:seedream-4": "doubao-seedream-4-0-250828",
    "doubao:seedream-3": "doubao-seedream-3-0-t2i-250415",
}


def _doubao_model_id(model_key: str) -> str:
    return DOUBAO_MODEL_MAP.get(model_key, DOUBAO_DEFAULT_ENDPOINT)


async def _call_doubao_image(prompt: str, size: str, model_key: str) -> ImageGenerateResponse:
    """调用豆包 Seedream 文生图。DOUBAO_IMG_ENDPOINT 可为 ep-xxx 或模型 ID。"""
    if not DOUBAO_DEFAULT_ENDPOINT:
        return ImageGenerateResponse(
            success=False, model=model_key, provider="doubao",
            error="豆包文生图未配置：请在 .env 设置 DOUBAO_IMG_ENDPOINT"
        )
    if not _volcengine_api_key():
        return ImageGenerateResponse(
            success=False, model=model_key, provider="doubao",
            error="豆包文生图未配置：缺少 VOLCENGINE_API_KEY 或 ARK_API_KEY"
        )
    headers = {
        "Authorization": f"Bearer {_volcengine_api_key()}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": _doubao_model_id(model_key),
        "prompt": prompt,
        "size": size,
        "response_format": "url",
        "seed": -1,
    }
    try:
        status, data = await _post_json_with_fallback(DOUBAO_IMG_BASE, headers, payload)
        if status != 200:
            err = data.get("error", data)
            err_msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
            logger.warning(f"Doubao image failed: {status} {err_msg}")
            return ImageGenerateResponse(
                success=False, model=model_key, provider="doubao",
                error=f"豆包调用失败: {err_msg}"
            )
        images = data.get("data", [])
        if not images:
            return ImageGenerateResponse(
                success=False, model=model_key, provider="doubao",
                error="豆包未返回图片"
            )
        img_url = images[0].get("url", "")
        if not img_url:
            return ImageGenerateResponse(
                success=False, model=model_key, provider="doubao",
                error="豆包返回结果无 url 字段"
            )
        return ImageGenerateResponse(
            success=True, image_url=img_url, model=model_key, provider="doubao"
        )
    except httpx.TimeoutException:
        return ImageGenerateResponse(
            success=False, model=model_key, provider="doubao", error="豆包请求超时"
        )
    except Exception as e:
        logger.error(f"Doubao image error: {e}")
        return ImageGenerateResponse(
            success=False, model=model_key, provider="doubao", error=str(e)
        )


POLLINATIONS_ALLOWED_HOSTS = {"image.pollinations.ai", "gen.pollinations.ai"}


@app.get("/image/proxy")
async def proxy_image(url: str):
    """代理 Pollinations 图片，避免前端跨域 / 401 导致 img 加载失败。"""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or parsed.hostname not in POLLINATIONS_ALLOWED_HOSTS:
        raise HTTPException(status_code=400, detail="不允许的图片来源")
    try:
        try:
            _, content, media_type = await asyncio.to_thread(_curl_get_sync, url, 90.0)
            return Response(
                content=content,
                media_type=media_type,
                headers={"Cache-Control": "public, max-age=86400"},
            )
        except Exception as curl_err:
            logger.warning(f"Image proxy curl failed: {curl_err}")
        resp = await _pollinations_fetch(url)
        if resp.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"图片源返回 {resp.status_code}")
        media_type = resp.headers.get("content-type") or "image/jpeg"
        if not media_type.startswith("image/"):
            media_type = "image/jpeg"
        return Response(
            content=resp.content,
            media_type=media_type,
            headers={"Cache-Control": "public, max-age=86400"},
        )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="图片获取超时")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Image proxy error: {e}")
        raise HTTPException(status_code=502, detail="图片代理失败")


def _doubao_image_configured() -> bool:
    return bool(DOUBAO_DEFAULT_ENDPOINT and _volcengine_api_key())


@app.get("/image/models")
async def list_image_models():
    """List available image generation models."""
    img_cfg = _get_image_config()
    doubao_ok = _doubao_image_configured()
    default_model = img_cfg.get("default_model") or ("doubao:seedream-4" if doubao_ok else "zimage")

    models = [
        {
            "id": "doubao:seedream-4",
            "name": "豆包 Seedream 4（免费额度 · 中文最准）" if doubao_ok else "豆包 Seedream 4（需配置 Key）",
            "free": True,
            "provider": "doubao",
            "configured": doubao_ok,
        },
        {"id": "zimage", "name": "Z-Image（免费 · 艺术风格）", "free": True, "provider": "pollinations", "configured": True},
        {"id": "flux", "name": "Flux（免费 · 写实摄影）", "free": True, "provider": "pollinations", "configured": True},
        {"id": "turbo", "name": "Turbo（免费 · 快速）", "free": True, "provider": "pollinations", "configured": True},
    ]
    for m in models:
        m["default"] = m["id"] == default_model
    return models


@app.post("/image/generate", response_model=ImageGenerateResponse)
async def generate_image(req: ImageGenerateRequest):
    """Generate an image via Pollinations / 豆包 Seedream."""
    img_cfg = _get_image_config()
    doubao_ok = _doubao_image_configured()
    model = req.model or img_cfg.get("default_model") or ("doubao:seedream-4" if doubao_ok else "zimage")
    if model not in IMAGE_MODELS:
        model = "zimage"
    size = req.image_size or img_cfg.get("default_size") or "1024x1024"
    try:
        w, h = size.split("x")
        w, h = int(w), int(h)
    except ValueError:
        w, h = 1024, 1024

    w = max(256, min(w, 2048))
    h = max(256, min(h, 2048))

    if not req.prompt or not req.prompt.strip():
        return ImageGenerateResponse(success=False, error="prompt 不能为空")

    prompt = req.prompt.strip()

    if model.startswith("doubao:"):
        result = await _call_doubao_image(prompt, size, model)
        if result.success:
            return result
        logger.info(f"豆包生图失败 ({result.error})，回退 Pollinations flux")
        img_url, resolved_model, _ = await _resolve_pollinations_image(prompt, w, h, "flux")
        return ImageGenerateResponse(
            success=True,
            image_url=img_url,
            model=resolved_model,
            provider="pollinations",
            error=f"豆包暂不可用，已自动改用免费 Flux",
        )

    img_url, resolved_model, provider = await _resolve_pollinations_image(prompt, w, h, model)
    return ImageGenerateResponse(
        success=True,
        image_url=img_url,
        model=resolved_model,
        provider=provider,
    )


# ============================================================
# Conversation Persistence — JSON 文件存储
# ============================================================

DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)


def _conv_file_path(user_key: str) -> Path:
    """安全拼接用户对话文件路径"""
    safe_key = "".join(c for c in user_key if c.isalnum() or c in "._-@")
    return DATA_DIR / f"conversations_{safe_key}.json"


def _load_conversations(user_key: str) -> list:
    path = _conv_file_path(user_key)
    if not path.exists():
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return []


def _save_conversations(user_key: str, conversations: list):
    path = _conv_file_path(user_key)
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(conversations, f, ensure_ascii=False, indent=2)
    except IOError as e:
        logger.error(f"Failed to save conversations: {e}")


class SaveConversationRequest(BaseModel):
    conversation: dict = Field(..., description="Conversation object with id, title, messages, etc.")


@app.get("/conversations/{user_key}")
async def get_conversations(user_key: str):
    """加载用户的所有对话"""
    convs = _load_conversations(user_key)
    return {"success": True, "conversations": convs}


@app.post("/conversations/{user_key}")
async def save_conversation(user_key: str, req: SaveConversationRequest):
    """保存或更新单个对话"""
    convs = _load_conversations(user_key)
    conv = req.conversation
    conv_id = conv.get("id", "")
    if not conv_id:
        return {"success": False, "error": "对话缺少 id"}

    # 更新或插入
    found = False
    for i, c in enumerate(convs):
        if c.get("id") == conv_id:
            convs[i] = conv
            found = True
            break
    if not found:
        convs.insert(0, conv)

    _save_conversations(user_key, convs)
    return {"success": True}


@app.delete("/conversations/{user_key}/{conv_id}")
async def delete_conversation(user_key: str, conv_id: str):
    """删除单个对话"""
    convs = _load_conversations(user_key)
    convs = [c for c in convs if c.get("id") != conv_id]
    _save_conversations(user_key, convs)
    return {"success": True}


@app.post("/conversations/{user_key}/save-all")
async def save_all_conversations(user_key: str, req: dict):
    """一次性保存所有对话"""
    conversations = req.get("conversations", [])
    _save_conversations(user_key, conversations)
    return {"success": True}


# ============================================================
# Static Assets — 必须放在所有 API 路由之后，否则 /{filename} 会拦截 /models 等
# ============================================================

_FRONTEND_ASSET_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".html"}


@app.get("/{filename}")
async def static_asset(filename: str):
    """Serve frontend static assets (images, etc.)."""
    if "/" in filename or filename.startswith("."):
        raise HTTPException(status_code=404, detail="Not found")
    ext = Path(filename).suffix.lower()
    if ext not in _FRONTEND_ASSET_EXTS:
        raise HTTPException(status_code=404, detail="Not found")
    file_path = FRONTEND_DIR / filename
    if not file_path.exists():
        file_path = STATIC_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(str(file_path))


# ============================================================
# Entry point
# ============================================================

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
