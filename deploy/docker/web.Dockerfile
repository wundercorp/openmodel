FROM node:22-alpine AS build
WORKDIR /workspace
COPY package.json package-lock.json* .npmrc ./
COPY apps/web/package.json apps/web/package.json
RUN npm install --workspace @wundercorp/openmodel-web --include-workspace-root
COPY apps/web apps/web
ARG VITE_AUTH_ISSUER=https://auth.wundercorp.co
ARG VITE_AUTH_CLIENT_ID=openmodel-web
ARG VITE_AUTH_AUDIENCE=https://api.openmodel.sh
ARG VITE_AUTH_REDIRECT_URI=https://openmodel.sh/auth/callback
ARG VITE_CLOUD_API_URL=https://api.openmodel.sh
ENV VITE_AUTH_ISSUER=$VITE_AUTH_ISSUER
ENV VITE_AUTH_CLIENT_ID=$VITE_AUTH_CLIENT_ID
ENV VITE_AUTH_AUDIENCE=$VITE_AUTH_AUDIENCE
ENV VITE_AUTH_REDIRECT_URI=$VITE_AUTH_REDIRECT_URI
ENV VITE_CLOUD_API_URL=$VITE_CLOUD_API_URL
RUN npm run build --workspace @wundercorp/openmodel-web

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
