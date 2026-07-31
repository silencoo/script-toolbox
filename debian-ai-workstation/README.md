# Debian AI Workstation

用于配置 Debian 13 GPU 开发与 AI 工作站的一体化安装脚本，包括常用工具、Docker、语言环境、NVIDIA/CUDA、Zsh 和 ComfyUI。它不是通用 VPS 初始化入口；服务器请使用 [`linux-server-toolkit`](../linux-server-toolkit/)。

> 脚本会修改 APT 软件源、安装系统软件、修改 `~/.zshrc` 并安装 NVIDIA/CUDA。请先阅读脚本，并仅在新系统或可恢复环境中运行。

## 使用方法

```bash
chmod +x setup.sh
./setup.sh
```

脚本中的终端代理默认指向 `http://127.0.0.1:7890`。如果本机不使用该代理，请在执行前修改或移除相关配置。
