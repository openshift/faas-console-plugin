FROM --platform=$BUILDPLATFORM registry.access.redhat.com/ubi9/nodejs-22:latest AS build
USER root
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm i -g corepack && corepack enable

WORKDIR /usr/src/app

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/ .yarn/
RUN yarn install --immutable

COPY --exclude=node_modules --exclude=backend . .
RUN  yarn build

FROM --platform=$BUILDPLATFORM registry.access.redhat.com/ubi9/go-toolset:1.26 AS go-build
ARG TARGETOS
ARG TARGETARCH

WORKDIR /opt/app-root/src/backend

COPY --chown=1001:0 backend/go.mod backend/go.sum /opt/app-root/src/backend/
RUN go mod download

COPY --chown=1001:0 --from=build /usr/src/app/dist /opt/app-root/src/backend/static
COPY --chown=1001:0 backend/ /opt/app-root/src/backend/
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -ldflags="-s -w" -o plugin-backend .

FROM registry.access.redhat.com/ubi9-micro:latest

COPY --from=go-build /opt/app-root/src/backend/plugin-backend /usr/bin/plugin-backend
USER 1001

ENTRYPOINT ["plugin-backend"]
