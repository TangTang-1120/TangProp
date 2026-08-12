# TangProp 部署指南

## 目录结构

```
deploy/
├── deploy.sh          # 一键部署脚本
├── nginx.conf         # Nginx 反向代理配置（可选，绑域名时用）
├── tangprop.html      # 前端副本（API 地址已改为同源）
└── backend/
    ├── main.py        # FastAPI 后端（已加静态文件托管）
    ├── Dockerfile     # Docker 部署
    ├── .dockerignore
    ├── .env.example   # 环境变量模板
    ├── requirements.txt
    ├── config/
    │   ├── default.yaml
    │   └── system_prompt.txt
    ├── models/
    ├── agent/
    └── static/
        └── index.html # 前端页面（由 FastAPI 托管）
```

## 部署方式

### 方式一：Docker 部署（推荐）

```bash
# 1. 上传 deploy 目录到服务器
scp -r deploy/ root@your-server-ip:/opt/tangprop/

# 2. SSH 登录服务器
ssh root@your-server-ip

# 3. 配置环境变量
cd /opt/tangprop
cp backend/.env.example backend/.env
vi backend/.env  # 填入你的 API Key

# 4. 一键部署
bash deploy.sh
```

### 方式二：直接运行

```bash
# 1. 上传 deploy 目录到服务器
# 2. 确保有 Python 3.10+
python3 --version

# 3. 配置环境变量
cd /opt/tangprop
cp backend/.env.example backend/.env
vi backend/.env

# 4. 运行部署脚本
bash deploy.sh
# 选择 2（直接运行）
```

### 方式三：后台常驻运行

```bash
# 安装依赖
cd /opt/tangprop/backend
python3 -m venv ../venv
../venv/bin/pip install -r requirements.txt

# 配置环境变量
cp .env.example .env
vi .env

# 后台启动
nohup ../venv/bin/python main.py > tangprop.log 2>&1 &

# 查看日志
tail -f tangprop.log

# 停止
pkill -f "python main.py"
```

## 绑定域名 + HTTPS（可选）

```bash
# 1. 安装 nginx
apt install nginx -y

# 2. 复制配置
cp /opt/tangprop/nginx.conf /etc/nginx/sites-available/tangprop
# 编辑配置，把 your-domain.com 改成你的域名
vi /etc/nginx/sites-available/tangprop

# 3. 启用
ln -s /etc/nginx/sites-available/tangprop /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx

# 4. 申请 HTTPS 证书
apt install certbot python3-certbot-nginx -y
certbot --nginx -d your-domain.com
```

## 防火墙配置

```bash
# 开放 8080 端口（或 80 如果用 nginx）
ufw allow 8080/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw reload
```

## 常用运维命令

```bash
# Docker 模式
docker logs -f tangprop        # 查看日志
docker restart tangprop        # 重启
docker stop tangprop           # 停止
docker rm tangprop             # 删除容器
docker build -t tangprop:latest backend/  # 重新构建

# 直接运行模式
tail -f tangprop.log           # 查看日志
pkill -f "python main.py"     # 停止
nohup venv/bin/python main.py > tangprop.log 2>&1 &  # 启动
```

## 安全注意事项

1. **.env 文件**：包含所有 API Key，不要提交到 Git，不要公开
2. **CORS**：生产环境建议把 `allow_origins=["*"]` 改成你的域名
3. **HTTPS**：如果用密码登录，务必启用 HTTPS
4. **端口**：8080 端口建议通过 Nginx 代理，不要直接暴露
