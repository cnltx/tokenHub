# 赚取Token计划 - 影子请求代理
FROM node:22-alpine

WORKDIR /app

# 复制服务代码
COPY server.js /app/server.js
COPY public /app/public
RUN mkdir -p /app/data

# 端口
EXPOSE 8788

# 数据卷（config.json 持久化）
VOLUME ["/app/data"]

CMD ["node", "server.js"]