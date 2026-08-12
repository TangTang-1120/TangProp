#!/usr/bin/env python3
"""
TangProp CLI — 终端对话入口

用法:
    python cli.py                     # 交互式对话
    python cli.py "帮我写个脚本"       # 单次对话
    python cli.py --provider deepseek # 指定模型 provider

首次使用: 复制 .env.example 为 .env，填入 API Key
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

# ── Add parent to path for local imports ──
sys.path.insert(0, str(Path(__file__).parent))

from models.adapter import ModelRegistry, resolve_env_vars
from agent.tools import create_default_tools
from agent.memory import MemoryManager
from agent.loop import AgentLoop, AgentConfig

# ── Terminal colors (ANSI) ──
BOLD = "\033[1m"
DIM = "\033[2m"
ITALIC = "\033[3m"
RESET = "\033[0m"
PURPLE = "\033[38;5;99m"
CYAN = "\033[38;5;51m"
GREEN = "\033[38;5;42m"
YELLOW = "\033[38;5;220m"
RED = "\033[38;5;203m"
GRAY = "\033[38;5;245m"
WHITE = "\033[38;5;255m"


def load_dotenv():
    """Minimal .env loader."""
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


def load_config():
    """Load YAML config with env var resolution."""
    import yaml
    config_path = Path(__file__).parent / "config" / "default.yaml"
    if config_path.exists():
        with open(config_path) as f:
            config = yaml.safe_load(f)
        return resolve_env_vars(config)
    return {"models": {"default_provider": "openai", "providers": {}}}


def load_system_prompt():
    prompt_path = Path(__file__).parent / "config" / "system_prompt.txt"
    if prompt_path.exists():
        return prompt_path.read_text(encoding="utf-8")
    return "You are TangProp, a powerful AI assistant."


def print_banner():
    print()
    print(f"  {PURPLE}{BOLD}TangProp{RESET} {GRAY}{DIM}v1.0{RESET}")
    print(f"  {GRAY}终端对话模式 — 输入消息开始，/exit 退出，/clear 清空会话{RESET}")
    print()


def print_thinking(turn: int):
    dots = "." * (turn % 4 + 1)
    print(f"\n  {PURPLE}{DIM}思考中{dots}{RESET}", end="", flush=True)


def print_tool_start(name: str, args: dict):
    args_str = json.dumps(args, ensure_ascii=False)
    if len(args_str) > 80:
        args_str = args_str[:77] + "..."
    print(f"\r  {CYAN}{BOLD}🔧 {name}{RESET} {GRAY}{args_str}{RESET}")


def print_tool_result(name: str, result):
    status = f"{GREEN}✓{RESET}" if result.success else f"{RED}✗{RESET}"
    summary = result.output[:100].replace("\n", " ") if result.output else result.error or ""
    print(f"  {status} {GRAY}{DIM}{summary}{RESET}")


def print_response(text: str):
    print(f"\n  {WHITE}{text}{RESET}")
    print()


def print_error(msg: str):
    print(f"\n  {RED}{BOLD}错误:{RESET} {msg}")


async def run_single(prompt: str, provider_name: str | None, config: dict):
    """Run a single prompt and exit."""
    registry = ModelRegistry(config)
    provider = registry.get_provider(provider_name)
    if not provider:
        print_error(
            "没有可用的模型！请在 .env 中设置 API Key：\n"
            "  OPENAI_API_KEY=sk-xxx\n"
            "  DEEPSEEK_API_KEY=sk-xxx"
        )
        return

    tools = create_default_tools(workspace=os.getcwd())
    memory = MemoryManager(workspace_root=os.getcwd())
    agent_config = AgentConfig(
        system_prompt=load_system_prompt(),
        workspace_root=os.getcwd(),
    )

    agent = AgentLoop(provider=provider, tools=tools, memory=memory, config=agent_config)

    result = await agent.run_with_callbacks(
        prompt,
        on_thinking=print_thinking,
        on_tool_start=print_tool_start,
        on_tool_result=print_tool_result,
    )
    print()  # clear thinking dots line
    print_response(result)


async def run_interactive(provider_name: str | None, config: dict):
    """Run interactive CLI session."""
    registry = ModelRegistry(config)
    provider = registry.get_provider(provider_name)
    if not provider:
        print_error(
            "没有可用的模型！\n\n"
            "请先配置 API Key：\n"
            "  1. cp .env.example .env\n"
            "  2. 编辑 .env 填入你的 API Key\n"
            "  3. 重新运行 python cli.py\n\n"
            f"支持的 provider: openai / deepseek / anthropic / hunyuan\n"
        )
        return

    tools = create_default_tools(workspace=os.getcwd())
    memory = MemoryManager(workspace_root=os.getcwd())
    agent_config = AgentConfig(
        system_prompt=load_system_prompt(),
        workspace_root=os.getcwd(),
    )

    agent = AgentLoop(provider=provider, tools=tools, memory=memory, config=agent_config)

    print_banner()
    print(f"  {GRAY}模型: {GREEN}{provider.default_model}{GRAY} | "
          f"工具: {CYAN}{', '.join(tools.list_tools())}{GRAY} | "
          f"记忆: {YELLOW}3层{RESET}")
    print()

    while True:
        try:
            user_input = input(f"  {BOLD}{PURPLE}你>{RESET} ").strip()
        except (EOFError, KeyboardInterrupt):
            print(f"\n  {GRAY}再见！{RESET}")
            break

        if not user_input:
            continue
        if user_input == "/exit":
            print(f"  {GRAY}再见！{RESET}")
            break
        if user_input == "/clear":
            print(f"  {GRAY}会话已清空{RESET}\n")
            continue

        try:
            result = await agent.run_with_callbacks(
                user_input,
                on_thinking=print_thinking,
                on_tool_start=print_tool_start,
                on_tool_result=print_tool_result,
            )
            print(f"\r{' ' * 30}", end="")  # clear thinking dots
            print_response(result)
        except Exception as e:
            print(f"\r{' ' * 30}", end="")
            print_error(f"{type(e).__name__}: {e}")
            print()


def main():
    load_dotenv()
    config = load_config()

    import argparse
    parser = argparse.ArgumentParser(description="TangProp CLI")
    parser.add_argument("prompt", nargs="?", help="单次对话内容")
    parser.add_argument("--provider", "-p", default=None, help="模型 provider (openai/deepseek/anthropic/hunyuan)")
    args = parser.parse_args()

    if args.prompt:
        asyncio.run(run_single(args.prompt, args.provider, config))
    else:
        asyncio.run(run_interactive(args.provider, config))


if __name__ == "__main__":
    main()
