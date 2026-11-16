FROM node:22-alpine

WORKDIR /app
COPY huawei-read.js ha-run.js config.json ./
COPY LICENSE ./

# No dependencies, ports, Supervisor API access, or host mounts are needed.
CMD ["node", "/app/ha-run.js"]
