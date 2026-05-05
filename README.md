# Serverless Functions Console

A Functions-as-a-Service PoC UI for the OpenShift Web Console. Developers create, edit, and deploy serverless functions without CLI knowledge.

Built as an [OpenShift Console dynamic plugin](https://github.com/openshift/console/tree/main/frontend/packages/console-dynamic-plugin-sdk) using React, TypeScript, and PatternFly 6.

Check out the **[Github page](https://twogiants.github.io/func-console/)** for a quick start or read ahead.

## Deployment on cluster

### Prerequisites

- [oc](https://console.redhat.com/openshift/downloads) CLI
- An [OpenShift 4.19 cluster](https://console.redhat.com/openshift/create)
- Github [*Personal Access Token*](https://github.com/settings/personal-access-tokens) with *administration*, *content*, *secret* and *workflow* write permissions in all repositories

### Quick install

```shell
oc new-project console-functions-plugin
oc apply -f https://twogiants.github.io/func-console/plugin.yaml
```

### Manual install (requires [Helm](https://helm.sh))

```shell
oc new-project console-functions-plugin
helm upgrade -i console-functions-plugin charts/openshift-console-plugin \
    -n console-functions-plugin --create-namespace \
    --set "plugin.image=ghcr.io/twogiants/console-functions-plugin:latest@sha256:<digest>"
```

To deploy a specific build, use its git commit SHA as the tag:

```shell
--set "plugin.image=ghcr.io/twogiants/console-functions-plugin:sha-<commit>"
```

Available image tags are listed in the [container registry](https://github.com/twoGiants/func-console/pkgs/container/console-functions-plugin). Consult the chart [values](charts/openshift-console-plugin/values.yaml) file for additional parameters.

## Development

### Prerequisites

- [Node.js](https://nodejs.org/en/) (v18+)
- [Yarn](https://yarnpkg.com) (v4)
- [oc](https://console.redhat.com/openshift/downloads) CLI
- [Docker](https://www.docker.com) or [podman 3.2.0+](https://podman.io)
- An [OpenShift cluster](https://console.redhat.com/openshift/create)
- Github [*Personal Access Token*](https://github.com/settings/personal-access-tokens) with *administration*, *content* and *workflow* write permissions in all repositories

### Option 1: Local

In one terminal window, run:

1. `yarn install`
2. `yarn run start`

In another terminal window, run:

1. `oc login` (requires [oc](https://console.redhat.com/openshift/downloads) and an [OpenShift cluster](https://console.redhat.com/openshift/create))
2. `yarn run start-console` (requires [Docker](https://www.docker.com) or [podman 3.2.0+](https://podman.io))

This will run the OpenShift console in a container connected to the cluster
you've logged into. The plugin HTTP server runs on port 9001 with CORS enabled.
Navigate to <http://localhost:9000/example> to see the running plugin.

#### Running start-console with Apple silicon and podman

If you are using podman on a Mac with Apple silicon, `yarn run start-console`
might fail since it runs an amd64 image. You can workaround the problem with
[qemu-user-static](https://github.com/multiarch/qemu-user-static) by running
these commands:

```bash
podman machine ssh
sudo -i
rpm-ostree install qemu-user-static
systemctl reboot
```

### Option 2: Docker + VSCode Remote Container

Make sure the
[Remote Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
extension is installed. This method uses Docker Compose where one container is
the OpenShift console and the second container is the plugin. It requires that
you have access to an existing OpenShift cluster. After the initial build, the
cached containers will help you start developing in seconds.

1. Create a `dev.env` file inside the `.devcontainer` folder with the correct values for your cluster:

```bash
OC_PLUGIN_NAME=console-functions-plugin
OC_URL=https://api.example.com:6443
OC_USER=kubeadmin
OC_PASS=<password>
```

2. `(Ctrl+Shift+P) => Remote Containers: Open Folder in Container...`
3. `yarn run start`
4. Navigate to <http://localhost:9000/example>

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

The plugin uses [react-i18next](https://react.i18next.com/) for translations. The i18n namespace must match
the name of the `ConsolePlugin` resource with the `plugin__` prefix to avoid
naming conflicts. This plugin uses the
`plugin__console-functions-plugin` namespace. You can use the `useTranslation` hook
with this namespace as follows:

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

Running `yarn i18n` updates the JSON files in the `locales` folder when adding or changing messages.

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
