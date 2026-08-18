FROM --platform=$BUILDPLATFORM registry.access.redhat.com/ubi9/nodejs-24:latest@sha256:fe35989e8393843ac6945d4f29539addb77b65b91c5076c41ea5493e4f9debb4 AS nodebuilder
USER root
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm i -g corepack && corepack enable

WORKDIR /usr/src/app

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/ .yarn/
RUN yarn install --immutable

COPY console-extensions.json tsconfig.json webpack.config.mts ./
COPY src/ src/
COPY locales/ locales/
COPY config/ config/
COPY testing/ testing/
RUN yarn build

FROM --platform=$BUILDPLATFORM registry.access.redhat.com/ubi9/go-toolset:1.26.5-1786971605@sha256:1a9bbbfa854931a97dbff276bd69dc0e32b36cb2fbce3b9813b2cf9892aa8d43 AS gobuilder
ARG TARGETOS TARGETARCH
ENV GOOS=$TARGETOS GOARCH=$TARGETARCH
WORKDIR /opt/app-root/src

COPY --chown=1001:0 backend/go.mod backend/go.sum backend/
RUN go -C backend mod download

COPY --chown=1001:0 --from=nodebuilder /usr/src/app/dist backend/static
COPY --chown=1001:0 backend/ backend/
RUN mkdir -p bin && CGO_ENABLED=0 go -C backend build -ldflags="-s -w" -o ../bin/plugin-backend .

FROM registry.access.redhat.com/ubi9-micro:latest@sha256:7e7f79ab747bf2b452e3043dd89f388e92be4c7fdcc8b815b58adf6c99c39c95
COPY --from=gobuilder /opt/app-root/src/bin/plugin-backend /usr/bin/plugin-backend
COPY --from=gobuilder /etc/pki/tls/certs/ca-bundle.crt /etc/pki/tls/certs/ca-bundle.crt
USER 1001

ENTRYPOINT ["plugin-backend"]
