# stzheng — personal site

Vite + React 的个人主页，push 到 main 后由 GitHub Actions 部署到 GitHub Pages。

```bash
npm i
npm run dev
```

构建用到的环境变量（本地放 `.env`，线上在仓库 Settings → Variables 配置）见 `.env.example`。
联系表单走 Supabase edge function `supabase/functions/contact-form`。
