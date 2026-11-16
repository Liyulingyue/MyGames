# ---------- 构建阶段 ----------
# 用 Debian(glibc) 而不是 alpine：TypeScript 7 是原生二进制，只提供 glibc 的可选依赖
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# 依赖单独一层，源码改动不会让 npm ci 缓存失效
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
# build = tsc --noEmit && vite build
RUN npm run build

# ---------- 运行阶段 ----------
FROM nginx:1.27-alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
