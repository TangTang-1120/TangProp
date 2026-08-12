# GitHub 部署说明

## 1. 推送代码

```bash
cd TangProp
git remote add origin https://github.com/TangTang-1120/TangProp.git  # 若尚未添加
git push -u origin main
```

## 2. 自动部署到腾讯云（GitHub Actions）

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

## 3. 手动部署

```bash
./deploy/push-to-tencent.sh
```
