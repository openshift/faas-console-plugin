FROM --platform=$BUILDPLATFORM registry.access.redhat.com/ubi9/nodejs-24:latest@sha256:8feecc79fd5e66134b5b71ebba38bd117f4527ee13c8748e8ff38e8b698eb6eb AS nodebuilder
USER root

WORKDIR /usr/src/app

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/ .yarn/
RUN if [ -f /cachi2/cachi2.env ]; then . /cachi2/cachi2.env; fi && CYPRESS_INSTALL_BINARY=0 node ./.yarn/releases/yarn-4.18.0.cjs install --immutable

COPY console-extensions.json tsconfig.json webpack.config.mts ./
COPY src/ src/
COPY locales/ locales/
COPY config/ config/
RUN if [ -f /cachi2/cachi2.env ]; then . /cachi2/cachi2.env; fi && node ./.yarn/releases/yarn-4.18.0.cjs build

FROM --platform=$BUILDPLATFORM registry.access.redhat.com/ubi9/go-toolset:1.26.7-1789040808@sha256:685ccca486cc2c82b0818d835abecb1aed7a396e76ba416cfc47c28067f5d365 AS gobuilder
ARG TARGETOS TARGETARCH
ENV GOOS=$TARGETOS GOARCH=$TARGETARCH
WORKDIR /opt/app-root/src

COPY --chown=1001:0 backend/go.mod backend/go.sum backend/
RUN if [ -f /cachi2/cachi2.env ]; then . /cachi2/cachi2.env; fi && \
    go -C backend mod download

COPY --chown=1001:0 --from=nodebuilder /usr/src/app/dist backend/static
COPY --chown=1001:0 backend/ backend/
RUN if [ -f /cachi2/cachi2.env ]; then . /cachi2/cachi2.env; fi && \
    mkdir -p bin && CGO_ENABLED=0 go -C backend build -ldflags="-s -w" -o ../bin/plugin-backend .

FROM registry.access.redhat.com/ubi9-micro:latest@sha256:f332c99eb8f798a8486821c91937f10ad64ee83d7e739303be2df051040918f6
COPY --from=gobuilder /opt/app-root/src/bin/plugin-backend /usr/bin/plugin-backend
COPY --from=gobuilder /etc/pki/tls/certs/ca-bundle.crt /etc/pki/tls/certs/ca-bundle.crt
USER 1001

LABEL name="openshift-serverless-tech-preview/functions-console-plugin-rhel9" \
      com.redhat.component="openshift-serverless-faas-console-plugin-container" \
      version="2.0" \
      release="1" \
      summary="OpenShift Serverless Functions Console Plugin" \
      description="A Functions-as-a-Service UI for the OpenShift Web Console" \
      io.k8s.display-name="OpenShift Serverless Functions Console Plugin" \
      io.k8s.description="A Functions-as-a-Service UI for the OpenShift Web Console" \
      io.openshift.tags="openshift,serverless,functions,faas,console,plugin" \
      maintainer="serverless-support@redhat.com"

ENTRYPOINT ["plugin-backend"]
