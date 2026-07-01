# Serverless Functions Console

A Functions-as-a-Service PoC UI for the OpenShift Web Console. Developers create, edit, and deploy serverless functions without CLI knowledge.

Built as an [OpenShift Console dynamic plugin](https://github.com/openshift/console/tree/main/frontend/packages/console-dynamic-plugin-sdk) using React, TypeScript, and PatternFly 6.

Check out the **[Github page](https://functions-dev.github.io/ocp-console-plugin/)** for a quick start or read ahead.

## Deployment on cluster

### Prerequisites

- [oc](https://console.redhat.com/openshift/downloads) CLI
- An [OpenShift 4.19 cluster](https://console.redhat.com/openshift/create)
- Github [*Personal Access Token*](https://github.com/settings/personal-access-tokens) with *administration*, *content*, *secret* and *workflow* write permissions in all repositories

### Quick install

```shell
oc new-project console-functions-plugin
oc apply -f https://functions-dev.github.io/ocp-console-plugin/plugin.yaml
```

### Manual install (requires [Helm](https://helm.sh))

```shell
oc new-project console-functions-plugin
helm upgrade -i console-functions-plugin charts/openshift-console-plugin \
    -n console-functions-plugin --create-namespace \
    --set "plugin.image=ghcr.io/functions-dev/ocp-console-plugin-functions-plugin:latest@sha256:<digest>"
```

To deploy a specific build, use its git commit SHA as the tag:

```shell
--set "plugin.image=ghcr.io/functions-dev/ocp-console-plugin-functions-plugin:sha-<commit>"
```

Available image tags are listed in the [container registry](https://github.com/functions-dev/ocp-console-plugin/pkgs/container/console-functions-plugin). Consult the chart [values](charts/openshift-console-plugin/values.yaml) file for additional parameters.

## Development

### Prerequisites

- [Node.js](https://nodejs.org/en/) (v18+)
- [Yarn](https://yarnpkg.com) (v4)
- [Go](https://go.dev/dl/) (v1.24+)
- [Helm](https://helm.sh/docs/intro/install/)
- [oc](https://console.redhat.com/openshift/downloads) CLI
- [Docker](https://www.docker.com) or [podman 3.2.0+](https://podman.io)
- An [OpenShift cluster](https://console.redhat.com/openshift/create)
- Github [*Personal Access Token*](https://github.com/settings/personal-access-tokens) with *administration*, *content* and *workflow* write permissions in all repositories
- [inotify-tools](https://github.com/inotify-tools/inotify-tools) (optional, enables Go backend auto-recompile on file changes)

### Setup

1. `oc login` to your OpenShift cluster
2. `yarn install`
3. `./init.sh`

This builds the pages assets (plugin.yaml, landing page), compiles the Go backend, starts the webpack dev server, and launches the OpenShift console in a container. Navigate to <http://localhost:9000> to see the running plugin.

To stop the dev environment:

```shell
./init.sh --stop
```

To use random ports (useful when defaults are already in use):

```shell
./init.sh --randomize-ports
```

### Viewing GitHub Pages locally

The landing page served at [functions-dev.github.io/ocp-console-plugin](https://functions-dev.github.io/ocp-console-plugin/) is built from `pages/index.html` and the Helm chart. The `init.sh` script generates these assets into `backend/static/` automatically, so the running backend serves them at <http://localhost:8080>.

## Docker image

Before you can deploy your plugin on a cluster, you must build an image and
push it to an image registry.

1. Build the image:

   ```sh
   docker build -t quay.io/my-repository/my-plugin:latest .
   ```

2. Run the image:

   ```sh
   docker run -it --rm -d -p 9001:80 quay.io/my-repository/my-plugin:latest
   ```

3. Push the image:

   ```sh
   docker push quay.io/my-repository/my-plugin:latest
   ```

NOTE: If you have a Mac with Apple silicon, you will need to add the flag
`--platform=linux/amd64` when building the image to target the correct platform
to run in-cluster.

## i18n

The plugin uses [react-i18next](https://react.i18next.com/) for translations, with
[i18next-cli](https://github.com/i18next/i18next-cli) for string extraction and
TypeScript type generation. The i18n namespace must match the name of the
`ConsolePlugin` resource with the `plugin__` prefix to avoid naming conflicts.
This plugin uses the `plugin__console-functions-plugin` namespace.

You can use the `useTranslation` hook with this namespace as follows:

```tsx
const Header: React.FC = () => {
  const { t } = useTranslation('plugin__console-functions-plugin');
  return <h1>{t('Hello, World!')}</h1>;
};
```

For labels in `console-extensions.json`, you can use the format
`%plugin__console-functions-plugin~My Label%`. Console will replace the value with
the message for the current language from the `plugin__console-functions-plugin`
namespace. For example:

```json
  {
    "type": "console.navigation/section",
    "properties": {
      "id": "functions-section",
      "perspective": "admin",
      "name": "%plugin__console-functions-plugin~Serverless Functions%"
    }
  }
```

Running `yarn i18n` extracts translatable strings into the JSON files in the
`locales` folder and regenerates TypeScript types in `src/types/`. The extraction
configuration is in `i18next.config.ts`. CI validates that locale files are up to
date, so run this command before committing whenever you add or change messages.

## Linting

This project adds prettier, eslint, and stylelint. Linting can be run with
`yarn run lint`.

The stylelint config disallows defining colors since these cause problems with dark
mode. Use [PatternFly semantic tokens](https://www.patternfly.org/tokens/all-patternfly-tokens)
for colors instead.

The stylelint config also disallows naked element selectors like `table` and
`.pf-` or `.co-` prefixed classes. This prevents plugins from accidentally
overwriting default console styles, breaking the layout of existing pages. The
best practice is to prefix your CSS class names with your plugin name to avoid
conflicts. Please don't disable these rules without understanding how they can
break console styles!

## Reporting

Steps to generate reports

1. In command prompt, navigate to root folder and execute the command `yarn run cypress-merge`
2. Then execute command `yarn run cypress-generate`
The cypress-report.html file is generated and should be in (/integration-tests/screenshots) directory.

## References

- [Console Plugin SDK README](https://github.com/openshift/console/tree/main/frontend/packages/console-dynamic-plugin-sdk)
- [Customization Plugin Example](https://github.com/spadgett/console-customization-plugin)
- [Dynamic Plugin Enhancement Proposal](https://github.com/openshift/enhancements/blob/master/enhancements/console/dynamic-plugins.md)
