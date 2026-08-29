#!/usr/bin/env bash

# Debian 13 GPU development and AI workstation bootstrap.

# build tool
sudo apt install build-essential cmake pkg-config libssl-dev zlib1g-dev \
libbz2-dev libreadline-dev libsqlite-dev llvm libncurses5-dev libncursesw5-dev \
xz-utils tk-dev libffi-dev liblzma-dev -y

# ffmpeg
sudo apt install ffmpeg libavcodec-extra imagemagick chafa -y

# unzip / zip
sudo apt install p7zip-full unrar-free unzip zip bzip2 p7zip-rar -y

# networking
sudo apt install axel curl wget mtr-tiny iperf3 dnsutils net-tools tcpdump -y

# system internals
sudo apt install lsof strace sysstat iotop rsync -y

# install ca
sudo apt install --reinstall ca-certificates
sudo update-ca-certificates

# Yazi official APT repository (Debian does not currently package Yazi)
curl -fsSL https://yazi-rs.github.io/builds/yazi-keyring.gpg | \
  sudo tee /usr/share/keyrings/yazi-keyring.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/yazi-keyring.gpg] https://yazi-rs.github.io/builds/ stable main' | \
  sudo tee /etc/apt/sources.list.d/yazi.list >/dev/null
sudo apt update

# install utils
sudo apt install fzf yazi procs btop bat fastfetch zoxide neovim duf ncdu gping ripgrep btm eza fd tealdeer lazygit jq httpie nvtop aria2 neovim tmux trash-cli -y

tldr --update
echo "alias cat='batcat --style=plain'" >> ~/.zshrc
echo "alias bat='batcat'" >> ~/.zshrc
curl https://getcroc.schollz.com | bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.5/install.sh | bash
nvm install --lts
# install docker
sudo apt remove $(dpkg --get-selections docker.io docker-compose docker-doc podman-docker containerd runc | cut -f1)
# Add Docker's official GPG key:
sudo apt update
sudo apt install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# Add the repository to Apt sources:
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# uv install
curl -LsSf https://astral.sh/uv/install.sh | sh
uv python install 3.12




# ==========================================
# 模块 1: Docker 显卡穿透 (NVIDIA Container Toolkit)
# ==========================================
# 1. 导入英伟达 Docker 源的 GPG 密钥
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /etc/apt/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/etc/apt/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

# 2. 刷新源并安装穿透工具 (带上 -E 保持代理)
sudo -E apt update
sudo -E apt install nvidia-container-toolkit -y

# 3. 重启 Docker 服务让配置生效
sudo systemctl restart docker


# ==========================================
# 模块 2: 显卡驱动与 CUDA 全家桶
# ==========================================
# 1. 清理无效的 NVIDIA 源列表，防止干扰
sudo rm -f /etc/apt/sources.list.d/cuda*.list

# 2. 安装必备的系统基础工具
sudo -E apt update
sudo -E apt install gnupg ca-certificates curl wget -y

# 3. 开启 Debian 系统的闭源驱动与固件下载权限
sudo sed -i 's/main$/main contrib non-free non-free-firmware/g' /etc/apt/sources.list
sudo sed -i 's/main/main contrib non-free non-free-firmware/g' /etc/apt/sources.list.d/*.list 2>/dev/null || true

# 4. 强制写入 NVIDIA 官方（Debian 12 兼容版）软件源，绕过 SHA1 签名封杀
echo "deb [trusted=yes] https://developer.download.nvidia.com/compute/cuda/repos/debian12/x86_64/ /" | sudo tee /etc/apt/sources.list.d/cuda-nvidia.list

# 5. 刷新系统软件源列表
sudo -E apt update

# 6. 安装当前系统内核对应的头文件 (编译内核模块必不可少)
sudo -E apt install linux-headers-$(uname -r) -y

# 7. 核心绝杀：一次性安装 驱动 + 面板(cuda-drivers) + 工具链(cuda-toolkit)
# (合并安装彻底杜绝依赖冲突，完美兼容当前 40 系列及未来 50 系列)
sudo -E apt install cuda-drivers cuda-toolkit -y

# 8. 将 CUDA 路径写入 Zsh 环境变量中
echo 'export PATH=/usr/local/cuda/bin:$PATH' >> ~/.zshrc
echo 'export LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH' >> ~/.zshrc

# 9. 提示重启
echo "NVIDIA Driver & CUDA Toolkit installed successfully!"
echo "Please run 'sudo reboot' to apply changes."



# install zsh and oh my zsh
# 1. 临时开启终端代理（确保能顺利连上 GitHub）
export http_proxy=http://127.0.0.1:7890
export https_proxy=http://127.0.0.1:7890

# 2. 确保系统安装了 git (Oh My Zsh 依赖它)
sudo apt install git -y

# 3. 运行 Oh My Zsh 官方一键安装脚本
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"



# change theme
# 把默认主题替换为 ys
sed -i 's/ZSH_THEME="robbyrussell"/ZSH_THEME="ys"/g' ~/.zshrc

# 刷新配置
source ~/.zshrc

# fill the env for .zshrc
cat << 'EOF' >> ~/.zshrc

# ==========================================
# 从 Bash 迁移过来的个人生产力工具
# ==========================================

# 1. 默认终端全局代理 (如果你更喜欢用命令行临时开关，也可以注释掉这三行)
export http_proxy="http://127.0.0.1:7890"
export https_proxy="http://127.0.0.1:7890"
export all_proxy="http://127.0.0.1:7890"

# 2. Local Bin 环境变量 (包含 Codex 与 Python 环境)
export PATH="$HOME/.local/bin:$PATH"
if [ -f "$HOME/.local/bin/env" ]; then
    . "$HOME/.local/bin/env"
fi

# 3. Zoxide 智能目录跳转 (已适配 Zsh)
eval "$(zoxide init zsh)"

# 4. Eza - 现代化 ls 替代品
alias ls="eza --color=always"
alias l="eza -lbF"
alias ll="eza -labF"
alias lt="eza --tree --level=2"

# 5. NVM - Node.js 版本管理器
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion
EOF





# rustup install
# 1. 执行官方一键安装脚本（全自动静默安装，无需手动确认）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# 2. 如果未来需要编译某些需要 C 语言桥接的 Rust 库，确保有基础编译链
sudo apt install build-essential pkg-config libssl-dev -y


# go install
# 1. 下载 Go 官方二进制包
wget https://go.dev/dl/go1.22.5.linux-amd64.tar.gz

# 2. 清理旧版本并解压到系统目录
sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf go1.22.5.linux-amd64.tar.gz

# 3. 删掉安装包清理空间
rm go1.22.5.linux-amd64.tar.gz


# add go and rust to profile
cat << 'EOF' >> ~/.zshrc

# ==========================================
# 开发语言环境 (Go & Rust)
# ==========================================
# Rust
export PATH="$HOME/.cargo/bin:$PATH"

# Go
export GO111MODULE=on
export GOPROXY=https://goproxy.cn,direct
export PATH="/usr/local/go/bin:$PATH"
export GOPATH="$HOME/go"
export PATH="$GOPATH/bin:$PATH"
EOF

# 刷新配置生效
source ~/.zshrc



# alias fd=fdfind
echo 'alias fd=fdfind' >> ~/.zshrc



# install yt-dlp
# 1. 下载最新版到系统的全局环境目录
sudo -E curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp

# 2. 赋予它可执行权限
sudo chmod a+rx /usr/local/bin/yt-dlp

# install gallery-dl in an isolated uv tool environment
$HOME/.local/bin/uv tool install gallery-dl




# install java sdk manager
curl -s "https://get.sdkman.io" | bash


# install comfyui
git clone https://github.com/Comfy-Org/ComfyUI
cd ComfyUI
uv venv
source .venv/bin/activate
uv pip install --pre torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cu132
uv pip install -r requirements.txt
uv pip install -r manager_requirements.txt
nano ./user/__manager/config.ini
# ad the network mode to personal_cloud
uv run main.py --enable-manager --listen 0.0.0.0





nano ~/.my_aliases

# Aria2 快捷下载
alias a2='aria2c --content-disposition-default-utf8=true'
# 引入自定义 alias
nano ~/.zshrc

if [ -f ~/.my_aliases ]; then
    . ~/.my_aliases
fi
