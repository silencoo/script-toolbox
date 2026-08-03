#!/usr/bin/env python3
# encoding: utf-8

"""Small, intentionally bounded HTTP request and User-Agent capture server."""

import argparse
import hmac
import json
import os
from collections import deque
from datetime import datetime
from threading import Lock

from flask import Flask, Response, jsonify, render_template_string, request

app = Flask(__name__)

request_logs = deque(maxlen=1000)
request_logs_lock = Lock()
admin_token = ""
sensitive_headers = {
    "authorization",
    "cookie",
    "proxy-authorization",
    "set-cookie",
    "x-api-key",
}
sensitive_arguments = {
    "api_key",
    "authorization",
    "key",
    "password",
    "secret",
    "token",
}


def dashboard_authorized():
    """Protect the log viewer and mutation endpoint with HTTP Basic auth."""
    if not admin_token:
        return request.remote_addr in {"127.0.0.1", "::1"}
    auth = request.authorization
    return bool(auth and hmac.compare_digest(auth.password or "", admin_token))


def require_dashboard_auth():
    if dashboard_authorized():
        return None
    return Response(
        "Dashboard authentication required.\n",
        401,
        {"WWW-Authenticate": 'Basic realm="User-Agent Capture"'},
    )

@app.route('/')
def home():
    """首页"""
    denied = require_dashboard_auth()
    if denied:
        return denied
    html_template = """
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>User-Agent测试服务器</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 20px; background-color: #f5f5f5; }
            .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
            .request { border: 1px solid #ddd; margin: 15px 0; padding: 15px; border-radius: 8px; background: #fafafa; }
            .user-agent { background: #e3f2fd; padding: 10px; margin: 10px 0; border-left: 4px solid #2196F3; border-radius: 4px; }
            .timestamp { color: #666; font-size: 12px; }
            .method { color: #4CAF50; font-weight: bold; }
            .url { color: #FF9800; word-break: break-all; }
            .refresh { margin: 20px 0; }
            .clear { margin: 20px 0; }
            .stats { background: #f0f0f0; padding: 15px; border-radius: 8px; margin: 20px 0; }
            pre { background: #f8f8f8; padding: 10px; border-radius: 4px; overflow-x: auto; }
            .highlight { background: #fff3cd; padding: 2px 4px; border-radius: 3px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>User-Agent测试服务器</h1>
                <p>服务器地址: <strong>{{ server_url }}</strong></p>
                <p>当前时间: {{ current_time }}</p>
            </div>

            <div class="stats">
                <h3>统计信息</h3>
                <p>总请求数: <strong>{{ total_requests }}</strong></p>
                <p>不同User-Agent数: <strong>{{ unique_uas }}</strong></p>
                <p>最后请求时间: <strong>{{ last_request_time }}</strong></p>
            </div>

            <div class="refresh">
                <button onclick="location.reload()" style="padding: 10px 20px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer;">刷新页面</button>
                <button onclick="clearLogs()" style="padding: 10px 20px; background: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer; margin-left: 10px;">清空日志</button>
            </div>

            <h2>请求日志</h2>

            {% for log in logs %}
            <div class="request">
                <div class="timestamp">时间: {{ log.timestamp }}</div>
                <div class="method">方法: {{ log.method }}</div>
                <div class="url">URL: {{ log.url }}</div>

                <div class="user-agent">
                    <strong>User-Agent:</strong>
                    <span class="highlight">{{ log.user_agent }}</span>
                </div>

                <div>
                    <strong>远程地址:</strong> {{ log.remote_addr }}
                </div>

                <details>
                    <summary>查看完整请求头</summary>
                    <pre>{{ log.headers_json }}</pre>
                </details>

                <details>
                    <summary>查看查询参数</summary>
                    <pre>{{ log.args_json }}</pre>
                </details>
            </div>
            {% endfor %}

            {% if not logs %}
            <div style="text-align: center; padding: 40px; color: #666;">
                <h3>暂无请求记录</h3>
                <p>请让123网盘离线下载访问此服务器</p>
                <p>测试URL: <code>{{ server_url }}test</code></p>
            </div>
            {% endif %}
        </div>

        <script>
            function clearLogs() {
                if (confirm('确定要清空所有日志吗？')) {
                    fetch('/clear', {method: 'POST'})
                        .then(() => location.reload());
                }
            }

            // 每30秒自动刷新
            setTimeout(() => location.reload(), 30000);
        </script>
    </body>
    </html>
    """

    with request_logs_lock:
        logs_snapshot = list(request_logs)
    total_requests = len(logs_snapshot)
    unique_uas = len(set(log['user_agent'] for log in logs_snapshot))
    last_request_time = logs_snapshot[-1]['timestamp'] if logs_snapshot else '无'

    return render_template_string(html_template,
                                server_url=request.host_url,
                                current_time=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                                logs=logs_snapshot[-20:],  # 只显示最近20条
                                total_requests=total_requests,
                                unique_uas=unique_uas,
                                last_request_time=last_request_time)

@app.route('/test')
def test():
    """测试端点"""
    return log_request()

@app.route('/api')
def api():
    """API端点"""
    return log_request()

@app.route('/download/<filename>')
def download(filename):
    """下载端点"""
    return log_request()

@app.route('/clear', methods=['POST'])
def clear_logs():
    """清空日志"""
    denied = require_dashboard_auth()
    if denied:
        return denied
    with request_logs_lock:
        request_logs.clear()
    return jsonify({"status": "success", "message": "日志已清空"})

def log_request():
    """记录请求信息"""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 获取请求信息
    user_agent = request.headers.get('User-Agent', '未知')
    method = request.method
    url = request.base_url
    remote_addr = request.remote_addr

    # Bound stored values and redact common credential-bearing headers.
    try:
        headers_dict = {
            key: "[REDACTED]" if key.lower() in sensitive_headers else value[:4096]
            for key, value in request.headers.items()
        }
        args_dict = {
            key: "[REDACTED]" if key.lower() in sensitive_arguments else value[:4096]
            for key, value in request.args.items()
        }
    except Exception as e:
        headers_dict = {"error": f"无法解析headers: {str(e)}"}
        args_dict = {"error": f"无法解析args: {str(e)}"}

    # 创建日志条目
    log_entry = {
        "timestamp": timestamp,
        "method": method,
        "url": url,
        "user_agent": user_agent,
        "remote_addr": remote_addr,
        "headers_json": json.dumps(headers_dict, indent=2, ensure_ascii=False),
        "args_json": json.dumps(args_dict, indent=2, ensure_ascii=False)
    }

    with request_logs_lock:
        request_logs.append(log_entry)

    # 打印到控制台
    print(f"\n{'='*60}")
    print(f"时间: {timestamp}")
    print(f"方法: {method}")
    print(f"URL: {url}")
    print(f"User-Agent: {user_agent}")
    print(f"远程地址: {remote_addr}")
    print(f"{'='*60}\n")

    # 返回响应
    response_data = {
        "status": "success",
        "timestamp": timestamp,
        "method": method,
        "url": url,
        "user_agent": user_agent,
        "remote_addr": remote_addr,
        "headers": headers_dict,
        "message": "请求已记录"
    }

    return jsonify(response_data)

def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1", help="listen address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=5000, help="listen port (default: 5000)")
    parser.add_argument(
        "--admin-token",
        default=os.environ.get("UA_CAPTURE_ADMIN_TOKEN", ""),
        help="dashboard password; defaults to UA_CAPTURE_ADMIN_TOKEN",
    )
    parser.add_argument("--max-logs", type=int, default=1000, help="maximum in-memory entries")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    if args.max_logs < 1:
        parser.error("--max-logs must be positive")
    if args.host not in {"127.0.0.1", "::1", "localhost"} and not args.admin_token:
        parser.error("a non-loopback --host requires --admin-token or UA_CAPTURE_ADMIN_TOKEN")
    return args


if __name__ == '__main__':
    options = parse_args()
    admin_token = options.admin_token
    request_logs = deque(maxlen=options.max_logs)

    print("User-Agent测试服务器启动")
    print("=" * 50)
    print("访问地址:")
    display_host = "localhost" if options.host in {"127.0.0.1", "::1", "localhost"} else options.host
    print(f"  http://{display_host}:{options.port}/")
    print(f"  http://{display_host}:{options.port}/test")
    print(f"  http://{display_host}:{options.port}/api")
    print(f"  http://{display_host}:{options.port}/download/test.zip")
    print("=" * 50)
    print("默认仅监听本机；公网或局域网监听必须设置管理口令。")
    print("=" * 50)

    app.run(host=options.host, port=options.port, debug=False, use_reloader=False)
