"""Shared HTTP helpers — bypass local proxy / DNS issues via curl fallback."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
from typing import Any

import httpx

logger = logging.getLogger("tangprop")


def curl_bin() -> str:
    return shutil.which("curl") or "/usr/bin/curl"


def no_proxy_env() -> dict[str, str]:
    env = os.environ.copy()
    for k in list(env.keys()):
        if k.lower() in ("http_proxy", "https_proxy", "all_proxy"):
            del env[k]
    return env


def httpx_client(timeout: float = 120.0, **kwargs: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=timeout, trust_env=False, **kwargs)


def curl_post_json_sync(
    url: str, headers: dict[str, str], payload: dict, timeout: float = 120.0
) -> tuple[int, dict]:
    body = json.dumps(payload, ensure_ascii=False)
    cmd = [
        curl_bin(),
        "-sS",
        "--noproxy",
        "*",
        "--max-time",
        str(int(timeout)),
        "-X",
        "POST",
        url,
        "-H",
        "Content-Type: application/json; charset=utf-8",
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
        env=no_proxy_env(),
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


async def post_json_with_fallback(
    url: str, headers: dict[str, str], payload: dict, timeout: float = 120.0
) -> tuple[int, dict]:
    curl_err: Exception | None = None
    try:
        return await asyncio.to_thread(curl_post_json_sync, url, headers, payload, timeout)
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
            last_err = RuntimeError(f"HTTP {resp.status_code}: {data}")
        except Exception as e:
            last_err = e
            if trust_env:
                break
            continue

    if last_err:
        raise RuntimeError(str(last_err))
    raise RuntimeError("POST failed")
