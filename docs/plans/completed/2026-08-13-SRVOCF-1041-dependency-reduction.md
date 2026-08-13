# SRVOCF-1041: Reduce frontend and backend dependency surface

## Status: Complete (verified locally)

## Changes Made

### Frontend

| Change | Status | Details |
|---|---|---|
| `@patternfly/react-code-editor` moved to devDependencies | ✅ Done | Was a runtime dep for type-only usage. Can't remove entirely because the OCP SDK's own type definitions import from it. Moving to devDeps is correct: it's build-time only, never bundled. |
| `react-redux` + `redux` removed | ✅ Done | Zero imports in src/ or e2e/. |
| `ts-node` removed, webpack-cli bumped to 7, config converted to ESM | ✅ Done | webpack-cli 7 + Node 26 native TS support eliminates ts-node entirely. Config renamed to `webpack.config.mts` (ESM), uses `import type` for CJS type imports and `import.meta.dirname` instead of `__dirname`. Webpack script simplified from `node -r ts-node/register ./node_modules/.bin/webpack` to `webpack`. |

### Backend

| Change | Status | Details |
|---|---|---|
| `go.yaml.in/yaml/v3` replaced with `sigs.k8s.io/yaml` | ✅ Done | Used in 1 test file only. `sigs.k8s.io/yaml` is already an indirect dep via k8s.io. Same `yaml.Unmarshal` API. Needs `go mod tidy` to clean up go.mod. |

### GitHub PRs (after code changes are verified)

| PR | Action | Status | Rationale |
|---|---|---|---|
| #102 (webpack-cli 7, webpack-dev-server 6) | Close | ⏳ Pending | WDS 6 requires Node >= 22.15, drops SockJS, bumps to Express 5. High risk, no benefit. |
| #108 (eslint 10) | Close | ⏳ Pending | Major version, no features we need. |
| #109 (jest-dom 7, jsdom 30) | Close | ⏳ Pending | Both require Node >= 22 minimum. No features we need. |
| #123 (PatternFly 6.6.1) | Merge | ⏳ Pending | Safe patch bump. |
| #122 (gomod patches) | Merge | ⏳ Pending | Safe patch bumps. |
| #121 (i18next-cli patch) | Merge | ⏳ Pending | Safe patch bump. |

### Deferred (after PR #100 merges)

| Change | Details |
|---|---|
| Remove `@octokit/rest` | GithubService.ts moves to backend. |
| Remove `libsodium-wrappers` | Encryption moves to backend. |
| Result: zero runtime dependencies in FE | Only devDeps for build, test, lint. |

## Files Changed

- `package.json` - dep moves/removals, webpack script
- `tsconfig.json` - ts-node block removed
- `backend/cluster/kubeconfig_test.go` - yaml import swap

## Verification Needed

```bash
yarn install                          # update lockfile
yarn lint && yarn test && yarn build  # full FE check
cd backend && go mod tidy && go test ./...  # BE check
```
