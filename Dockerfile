# Single-stage image on purpose: this is a small internal tool for 1-3 users,
# not a high-traffic product. Keeping devDependencies in the final image trades
# a bit of image size for a much simpler, easier-to-debug container — you can
# `docker compose exec app sh` and run any npm script directly in production.
FROM node:20-alpine

WORKDIR /app

# System deps needed by some native/optional bindings + healthchecks
RUN apk add --no-cache curl

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

RUN chmod +x docker-entrypoint.sh

EXPOSE 3060
ENTRYPOINT ["./docker-entrypoint.sh"]
