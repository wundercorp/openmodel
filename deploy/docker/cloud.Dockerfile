FROM node:22-alpine
WORKDIR /workspace
COPY package.json package-lock.json* .npmrc ./
COPY apps/cloud/package.json apps/cloud/package.json
RUN npm install --workspace @wundercorp/openmodel-cloud --include-workspace-root
COPY apps/cloud apps/cloud
WORKDIR /workspace/apps/cloud
EXPOSE 8787
CMD ["npx", "wrangler", "dev", "--ip", "0.0.0.0", "--port", "8787", "--local"]
