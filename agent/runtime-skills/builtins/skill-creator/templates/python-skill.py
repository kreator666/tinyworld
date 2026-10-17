#!/usr/bin/env python3
"""
TinyWorld 用户自定义 Python 技能模板。
技能通过 stdio JSON Lines 协议与 Agent 通信。

约束(必须遵守):
1. 只能使用 Python 标准库;
2. 网络请求只能用 urllib.request,且只能访问明确允许的域名;
3. 禁止读写技能目录之外的文件;
4. 工具名必须在 skill.json 中声明一致。
"""

import json
import sys
import urllib.request
import urllib.error

# ===== 允许访问的域名白名单(逗号分隔),空字符串表示禁止外网请求 =====
ALLOWED_DOMAINS = set(filter(None, (sys.argv[1] if len(sys.argv) > 1 else "").split(",")))


def safe_http_get(url: str) -> dict:
    """仅允许访问白名单域名的 GET 请求"""
    from urllib.parse import urlparse
    domain = urlparse(url).hostname or ""
    if not ALLOWED_DOMAINS or domain not in ALLOWED_DOMAINS:
        raise PermissionError(f"域名 {domain} 不在白名单中")
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            return {"status": resp.status, "body": resp.read().decode("utf-8", errors="replace")}
    except urllib.error.URLError as e:
        return {"error": str(e)}


# ===== 在这里实现你的工具函数 =====
def {{tool_name}}(args: dict) -> dict:
    """
    {{tool_description}}
    """
{{implementation}}


TOOLS = [
    {
        "name": "{{tool_name}}",
        "description": "{{tool_description}}",
        "inputSchema": {{input_schema}},
        "outputSchema": {"type": "object", "properties": {"result": {"type": "string"}}},
    }
]


def send(msg: dict) -> None:
    print(json.dumps(msg, ensure_ascii=False))
    sys.stdout.flush()


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            send({"type": "error", "error": "invalid json"})
            continue

        msg_type = req.get("type")
        req_id = req.get("id", "")

        if msg_type == "tools/list":
            send({"type": "tools", "tools": TOOLS, "id": req_id})
        elif msg_type == "tool/call":
            name = req.get("name")
            args = req.get("args", {})
            try:
                if name == "{{tool_name}}":
                    result = {{tool_name}}(args)
                    send({"type": "result", "result": result, "id": req_id})
                else:
                    send({"type": "error", "error": f"unknown tool: {name}", "id": req_id})
            except Exception as e:
                send({"type": "error", "error": str(e), "id": req_id})
        else:
            send({"type": "error", "error": f"unknown type: {msg_type}", "id": req_id})


if __name__ == "__main__":
    main()
