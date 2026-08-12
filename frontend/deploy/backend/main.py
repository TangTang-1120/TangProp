"""
TangProp Backend — FastAPI Server

启动: python main.py
启动后访问: http://localhost:8080/docs (Swagger UI)
"""
from __future__ import annotations

import json
import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

import uvicorn
import yaml
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from models.adapter import (
    ModelRegistry,
    resolve_env_vars,
)
from agent.tools import create_default_tools, ToolRegistry
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


# ============================================================
# API Models
# ============================================================

class ChatRequest(BaseModel):
    message: str = Field(..., description="User message")
    provider: Optional[str] = Field(None, description="Model provider to use")
    model: Optional[str] = Field(None, description="Specific model name")
    max_turns: int = Field(30, ge=1, le=50, description="Max agent turns")
    temperature: float = Field(0.3, ge=0.0, le=1.0)


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
    return {
        "name": "TangProp API",
        "version": "1.0.0",
        "providers": state.model_registry.list_providers() if state else [],
        "tools": state.tools.list_tools() if state else [],
        "status": "ready" if state and state.provider else "unconfigured",
    }


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
        temperature=req.temperature,
        workspace_root=state.workspace_root,
        system_prompt=state.system_prompt,
    )

    agent = AgentLoop(
        provider=provider,
        tools=state.tools,
        memory=state.memory,
        config=agent_config,
    )

    logger.info(f"Chat request: '{req.message[:80]}...'")
    response = await agent.run(req.message)

    return ChatResponse(
        response=response,
        turns=agent.turn_count,
        status=agent.status.value,
        step_log=agent.get_step_log() if agent.turn_count > 1 else None,
    )


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    """Stream a WorkBuddy response."""
    if not state or not state.provider:
        raise HTTPException(status_code=503, detail="No model provider configured.")

    provider = state.model_registry.get_provider(req.provider) or state.provider
    agent_config = AgentConfig(
        max_turns=req.max_turns,
        temperature=req.temperature,
        workspace_root=state.workspace_root,
        system_prompt=state.system_prompt,
    )
    agent = AgentLoop(provider=provider, tools=state.tools, memory=state.memory, config=agent_config)

    async def generate():
        async for chunk in agent.run_stream(req.message):
            yield chunk

    return StreamingResponse(generate(), media_type="application/x-ndjson")


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
    phone: str
    name: str
    plan: str
    created_at: str


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
        phone=sess["phone"],
        name=sess["name"],
        plan=sess["plan"],
        created_at=sess["created_at"],
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
        if len(avatar) > 10:
            raise HTTPException(status_code=400, detail="头像格式不正确")
        sess["avatar"] = avatar
    return {"success": True, "user": {
        "id": sess["user_id"],
        "phone": sess["phone"],
        "name": sess["name"],
        "plan": sess["plan"],
        "avatar": sess.get("avatar", ""),
        "created_at": sess["created_at"],
    }}


# ============================================================
# Entry point
# ============================================================

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
