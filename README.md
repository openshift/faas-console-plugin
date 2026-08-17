# Serverless Functions Console

A Functions-as-a-Service PoC UI for the OpenShift Web Console. Developers create, edit, and deploy serverless functions without CLI knowledge.

Built as an [OpenShift Console dynamic plugin](https://github.com/openshift/console/tree/main/frontend/packages/console-dynamic-plugin-sdk) using Go, React, TypeScript, and PatternFly 6.

## Team Values

- Support each other and find time for each other
- Deliver high quality output
- Communicate often and speak freely without hesitation
- Care about bringing value to the customer

## Guides

| Guide | Description |
|-------|-------------|
| [Agile Workflow](docs/AGILE.md) | Issue tracking, branching, pull requests |
| [Architecture](docs/ARCHITECTURE.md) | Layered architecture, dependency rules, and React patterns |
| [Style Guide](docs/STYLEGUIDE.md) | Code style, naming conventions, commit conventions, CSS rules, and OCP plugin constraints |
| [Testing](docs/TESTING.md) | TDD approach, test layers, mock strategy, and file conventions |

### Templates

| Template | Description |
|----------|-------------|
| [PR Template](.github/pull_request_template.md) | Pull request description format |
| [Jira Epic](docs/templates/jira-epic-template.md) | Template for creating Jira epics |
| [Jira Story](docs/templates/jira-story-template.md) | Template for creating Jira stories |
| [Jira Bug](docs/templates/jira-bug-template.md) | Template for filing Jira bugs |

### Slash Commands

| Command | Description |
|---------|-------------|
| `/begin` | Start a session, orient, and pick work |
| `/commit` | Create a git commit |
| `/create-pr` | Run pre-checks, review, and create a PR |
| `/e2e` | Scaffold and debug Playwright e2e tests |
| `/scrutinise` | Critically review your own output |

## Deployment on cluster

### Prerequisites

- [oc](https://console.redhat.com/openshift/downloads) CLI
- An [OpenShift 4.22+ cluster](https://console.redhat.com/openshift/create)
- Github [*Personal Access Token*](https://github.com/settings/personal-access-tokens) with *administration*, *content*, *secret* and *workflow* write permissions in all repositories

### Quick Install (via Operator)

Installs OpenShift Serverless, Knative Serving, and the Functions operator (which deploys the console plugin). The operator catalog always contains the latest console plugin build, kept current automatically by Konflux.

```shell
# 1. Install the operators
oc apply -f https://raw.githubusercontent.com/openshift/faas-console-plugin/master/install.yaml

# 2. Install Knative Serving (requires the Serverless operator CRDs)
oc apply -f - <<EOF
apiVersion: operator.knative.dev/v1beta1
kind: KnativeServing
metadata:
  name: knative-serving
  namespace: knative-serving
spec: {}
EOF

# 3. Enable the console plugin - can also be done through the UI
oc patch consoles.operator.openshift.io cluster --type=json \
  --patch='[{"op":"add","path":"/spec/plugins/-","value":"console-functions-plugin"}]'
```

## Development

### Prerequisites

- [Node.js](https://nodejs.org/en/) (v22+)
- [Yarn](https://yarnpkg.com) (v4)
- [Go](https://go.dev/dl/) (v1.26+)
- [Helm](https://helm.sh/docs/intro/install/)
- [oc](https://console.redhat.com/openshift/downloads) CLI
- [Podman](https://podman.io) (v3.2.0+)
- An [OpenShift cluster](https://console.redhat.com/openshift/create)
- Github [*Personal Access Token*](https://github.com/settings/personal-access-tokens) with *administration*, *content* and *workflow* write permissions in all repositories
- [gh](https://cli.github.com/) CLI (optional, enables your agent to create/update PRs)
- [fswatch](https://github.com/emcrisostomo/fswatch) (optional, enables Go backend auto-recompile on file changes)
- [Superpowers](https://github.com/obra/superpowers) (optional, enables your coding agents to brainstorm, write plans, use tdd, etc.)
- [Jira CLI](https://github.com/ankitpokhrel/jira-cli/wiki/Installation) (optional, enables your coding agent to read Jira tickets)

### Cluster setup

```shell
oc login ...
make setup-serverless       # install Serverless operator + Knative Serving (optional)
```

### Setup

```shell
make dev                    # build + start webpack + console container
make dev-stop               # stop dev environment
make dev-randomize-ports    # start with random ports (when defaults are in use)
```

Navigate to <http://localhost:9000> to see the running plugin.

### Testing

```shell
make unit                               # frontend + backend unit tests
make test-e2e                           # Playwright e2e (requires make dev running)
make test-e2e ARGS="--headed"           # visible browser
make test-e2e ARGS="--ui"              # interactive UI mode
```

See [docs/TESTING.md](docs/TESTING.md#e2e-conventions) for full conventions, helpers, and environment variables.

### Deploy to cluster

To deploy a production-like image to the cluster instead of running locally:

```shell
make deploy-dev             # build image, push to internal registry, deploy
```

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

Running `make verify` checks i18n freshness and extracts translatable strings
into the JSON files in the `locales` folder. The extraction configuration is in
`i18next.config.ts`.

## Linting

This project adds prettier, eslint, stylelint, and golangci-lint. Linting can
be run with `make lint`.

The stylelint config disallows defining colors since these cause problems with dark
mode. Use [PatternFly semantic tokens](https://www.patternfly.org/tokens/all-patternfly-tokens)
for colors instead.

The stylelint config also disallows naked element selectors like `table` and
`.pf-` or `.co-` prefixed classes. This prevents plugins from accidentally
overwriting default console styles, breaking the layout of existing pages. The
best practice is to prefix your CSS class names with your plugin name to avoid
conflicts. Please don't disable these rules without understanding how they can
break console styles!

## References

- [Console Plugin SDK README](https://github.com/openshift/console/tree/main/frontend/packages/console-dynamic-plugin-sdk)
- [Customization Plugin Example](https://github.com/spadgett/console-customization-plugin)
- [Dynamic Plugin Enhancement Proposal](https://github.com/openshift/enhancements/blob/master/enhancements/console/dynamic-plugins.md)
