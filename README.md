# TangProp 1.0.0 — 智能助手

> 单页 AI 助手 + Agent 工作台（Workbench）。左对话 / 右浏览器实时预览，模型直接产出可运行的 HTML。

## 目录结构

```
TangProp/
├── frontend/        # 前端源码（tangprop.html 单文件应用 + 图片资源）
├── backend/         # Python FastAPI 后端（agent loop、模型路由、工具系统）
├── deploy/          # 部署包（nginx 配置 + 启动脚本 + 静态资源）
└── README.md        # 本文件
```

## 启动方式

### 后端（端口 8080）
```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env       # 配置模型 API Key（OpenAI / DeepSeek / 豆包 / 硅基流动 / 智谱 等）
python main.py
```

### 前端（开发）
直接双击打开 `frontend/tangprop.html`（浏览器会自动用 `http://localhost:8080` 作为 API 地址）。

### 生产部署
```bash
# 1) 部署前端到 nginx 静态目录
sudo cp -R frontend/* /var/www/tangprop/

# 2) 部署后端
sudo cp -R backend /opt/tangprop-backend
cd /opt/tangprop-backend
sudo python3 -m venv venv
sudo venv/bin/pip install -r requirements.txt

# 3) 配置 nginx（参考 deploy/nginx.conf）
sudo cp deploy/nginx.conf /etc/nginx/sites-available/tangprop
sudo ln -s /etc/nginx/sites-available/tangprop /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 4) 配置 systemd 服务（参考 deploy/backend_ctl.sh）
```

## 主要功能

- **Agent 工作台（Workbench）**：新建任务自动进入"左对话 + 右浏览器预览"模式
- **多模型路由**：OpenAI / Anthropic / DeepSeek / 智谱 / 火山方舟 / 硅基流动 / 豆包语音 / 豆包文生图
- **图像生成**：豆包 Seedream / Pollinations（免 Key）/ 硅基流动 Kolors
- **专家中心**：内置多个领域专家（律师、医生、教师、金融等）
- **对话持久化**：本地 JSON 文件存储
- **手机号 + 邮箱验证码登录**：腾讯云 SMS + SMTP

## 新版本特性（v1.0）

- 新增 `/workbench/run` 流式端点，专门为 Workbench 设计，强制模型输出可预览 HTML
- "新任务"按钮直接跳转到 Agent 工作台，无需手动切换
- Workbench 真正接入 `/workbench/run` 流式协议，从模型回复中自动抽取 ````html` 块写入右侧 iframe
- 实时聊天文本 + 实时预览同步渲染

## 文档

- API Swagger: 启动后访问 `http://localhost:8080/docs`
- 部署配置: `deploy/README.md`
- 模型配置: `backend/config/default.yaml`