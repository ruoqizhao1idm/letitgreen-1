# letitgreen

项目目录结构：

- `server/` 后端代码（入口 `server/index.js`）
- `client/` 前端 React + Vite 代码
- `package.json` 根脚本，支持并发启动
- `eng.traineddata` OCR 训练数据（可放一份即可）

## 快速启动

1. 安装依赖

```bash
npm install
cd client && npm install
```

2. 复制环境变量

```bash
copy .env.example .env
# 编辑 .env: 填写 MONGO_URI、DEESEEK_API_KEY
```

3. 开发模式（前后端同时运行）

```bash
npm run dev
```

4. 生产模式

```bash
npm run build
npm start
```

## 常见问题

- 若前端从 `http://localhost:5173` 并发运行，后端接口 `/api` 正常访问。
- 若希望后端直接服务静态前端：先 `npm run build`，然后 `npm start`。
- 运行失败时，检查 `MONGO_URI` 是否可连，`DEESEEK_API_KEY` 是否可用。
