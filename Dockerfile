FROM node:24-alpine
ENV NODE_ENV=production TOKENHUB_HOST=0.0.0.0 TOKENHUB_PORT=3000 TOKENHUB_CONTAINER=1
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.TOKENHUB_PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/cli.js", "start"]
