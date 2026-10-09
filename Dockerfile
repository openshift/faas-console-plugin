FROM --platform=$BUILDPLATFORM registry.access.redhat.com/ubi9/nodejs-24:latest@sha256:36af0bcb31021be93b0aab49e3ebcbbe07326496a550cface3294634fe7e6433 AS nodebuilder
USER root

WORKDIR /usr/src/app

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/ .yarn/
RUN if [ -f /cachi2/cachi2.env ]; then . /cachi2/cachi2.env; fi && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 node .yarn/releases/yarn-*.cjs install --immutable

COPY console-extensions.json tsconfig.json webpack.config.mts ./
COPY src/ src/
COPY locales/ locales/
COPY config/ config/
RUN if [ -f /cachi2/cachi2.env ]; then . /cachi2/cachi2.env; fi && node .yarn/releases/yarn-*.cjs build

FROM --platform=$BUILDPLATFORM registry.access.redhat.com/ubi9/go-toolset:1.26.7-1791479310@sha256:6f246e8913d082df463b62a74c72f0d2b410583e1b2ac48add39cd7ede59ce62 AS gobuilder
ARG TARGETOS TARGETARCH
ENV GOOS=$TARGETOS GOARCH=$TARGETARCH
ENV GOFIPS140=v1.0.0
WORKDIR /opt/app-root/src

COPY --chown=1001:0 backend/go.mod backend/go.sum backend/
RUN if [ -f /cachi2/cachi2.env ]; then . /cachi2/cachi2.env; fi && \
    go -C backend mod download

COPY --chown=1001:0 --from=nodebuilder /usr/src/app/dist backend/static
COPY --chown=1001:0 backend/ backend/
RUN if [ -f /cachi2/cachi2.env ]; then . /cachi2/cachi2.env; fi && \
    mkdir -p bin && CGO_ENABLED=0 go -C backend build -ldflags="-s -w" -o ../bin/plugin-backend .

FROM registry.access.redhat.com/ubi9-micro:latest@sha256:7a0454cbd9bd847e8f6a63b6f0254a6efbeb6e0ed71a5d824a4f6cccbe626650
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
      maintainer="serverless-support@redhat.com" \
      cpe="cpe:/a:redhat:openshift_serverless:2.0::el9"

ENTRYPOINT ["plugin-backend"]
