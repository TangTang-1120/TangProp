# GitHub 部署说明

## 1. 推送代码

```bash
cd TangProp
git remote add origin https://github.com/TangTang-1120/TangProp.git  # 若尚未添加
git push -u origin main
```

## 2. GitHub Pages（前端静态站）

推送 `main` 后会执行 `.github/workflows/pages.yml`，站点地址：

**https://tangtang-1120.github.io/TangProp/**

首次启用：仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**。

> Pages 只托管前端。聊天 / 生图等需后端时，可在地址后加 `?api=https://你的后端地址`，或在控制台执行：
> `localStorage.setItem('TANGPROP_API','https://你的后端')` 后刷新。

## 3. 自动部署到腾讯云（GitHub Actions，保留）

在 GitHub 仓库 **Settings → Secrets and variables → Actions** 添加：

| Secret | 说明 |
|--------|------|
| `TENCENT_HOST` | 服务器 IP，如 `1.14.47.189` |
| `TENCENT_USER` | SSH 用户，如 `root` |
| `TENCENT_SSH_KEY` | 部署私钥全文（`~/.ssh/tangtang_deploy`） |

推送 `main` 分支后会自动执行 `.github/workflows/deploy-tencent.yml`。

> **首次推送 workflow 文件**：若报错 `refusing to allow an OAuth App ... without workflow scope`，在本机执行：
> ```bash
> gh auth refresh -s workflow
> git push origin main
> ```
> 或将 workflow 文件在 GitHub 网页端 **Add file → Create new file** 粘贴上传。

**注意**：服务器上的 `/opt/tangprop/backend/.env` 需手动维护，不会被 Git 覆盖。

## 4. 手动部署腾讯云

```bash
./deploy/push-to-tencent.sh
```
