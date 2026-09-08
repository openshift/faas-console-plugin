## Component Diagrams

These diagrams show which processes run where and how they communicate for each make target. 
Legend: 
- `[process]` = native OS process
- `[container]` = local Podman container
- `[pod]` = Kubernetes/OpenShift pod, parallelograms = external cloud services.

---

### make dev

```mermaid
graph TB
    subgraph local["Local Machine"]
        browser["Browser"]
        console["[container]\nOCP Console\n(:9000)"]
        plugin["[process]\nPlugin (webpack)\n(:9001)"]
        backend["[process]\nGo Backend\n(:8080)"]
    end

    subgraph gh["GitHub (cloud)"]
        ghapi[/"GitHub API\napi.github.com"/]
        ghactions[/"GitHub Actions\n(workflow runner)"/]
    end

    subgraph cluster["OpenShift Cluster"]
        kubeapi["Kube API Server"]
        knative["Knative / Functions"]
    end

    browser --> console
    console --> plugin
    console --> backend
    backend -- "push code,\nstore secrets" --> ghapi
    ghapi -- "push triggers" --> ghactions
    ghactions -- "func deploy\n(kubeconfig secret)" --> kubeapi
    kubeapi --> knative
    backend --> kubeapi
```

---

### make dev-fake-gh

```mermaid
graph TB
    subgraph local["Local Machine"]
        browser["Browser"]
        console["[container]\nOCP Console\n(:9000)"]
        plugin["[process]\nPlugin (webpack)\n(:9001)"]
        backend["[process]\nGo Backend\n(:9080)"]
        subgraph fgh["[process] fakegithub (:8090)"]
            fghapi["fakegithub API"]
            memstore["In-memory store"]
        end
        actrunner["[process] act runner (-self-hosted)"]
        funcdeploy["[process]\nfunc deploy"]
        lifecycle["[containers]\nS2I builder\n(via Podman)"]
    end

    subgraph cluster["OpenShift Cluster"]
        kubeapi["Kube API Server"]
        registry["Image Registry"]
        knative["Knative / Functions"]
    end

    browser --> console
    console --> plugin
    console --> backend
    backend -- "gh-api-url=localhost:8090" --> fghapi
    fghapi --> memstore
    fghapi -- "UpdateRef triggers" --> actrunner
    actrunner --> memstore
    actrunner -- "runs" --> funcdeploy
    funcdeploy -- "build" --> lifecycle
    lifecycle -- "push image" --> registry
    funcdeploy -- "deploy\n(kubeconfig secret)" --> kubeapi
    kubeapi --> knative
    backend --> kubeapi
    style fgh fill:#5c5b5b,stroke:#999
```

---

### make test-e2e

Runs Playwright tests against an already-running dev environment (`make dev-fake-gh`).

```mermaid
graph TB
    subgraph local["Local Machine (already running)"]
        console["[container]\nOCP Console\n(:9000)"]
        plugin["[process]\nPlugin (webpack)\n(:9001)"]
        backend["[process]\nGo Backend\n(:8080)"]
        fgh["[process]\nfakegithub\n(:8090)"]
    end

    subgraph test["Test Runner (Playwright)"]
        pw["[process]\nPlaywright\ntest suite"]
        seed["fakegithub.ts\nhelpers"]
    end

    pw -- "browser automation" --> console
    console --> plugin
    console --> backend
    seed -- "POST /_admin/seed\nPOST /_admin/reset" --> fgh
    backend --> fgh
```

---

### hack/builder-run.sh make e2e

Local equivalent of the Prow CI flow. Builds and runs a builder container that executes `make e2e` with a real cluster kubeconfig.

```mermaid
graph TB
    subgraph local["Local Machine"]
        sh["[process]\nbuilder-run.sh"]
        subgraph builder["[container] Builder (Dockerfile.buildroot)"]
            pw["[process]\nPlaywright\ntest suite"]
            seed["fakegithub.ts\nhelpers"]
            pf["[process]\nkubectl port-forward\nlocalhost:8090"]
        end
    end

    subgraph cluster["OpenShift Cluster"]
        subgraph fghpod["[pod] fakegithub pod"]
            fghapi["fakegithub API"]
            memstore["In-memory store"]
            subgraph actrunner["[process] act runner"]
                funcdeploy["[process]\nfunc deploy"]
                s2ibuild["[process]\nS2I build"]
            end
        end
        pluginpod["[pod] Plugin pod\n(backend + frontend)"]
        console["[pod]\nOCP Console"]
        kubeapi["Kube API Server"]
        knative["Knative / Functions"]
        registry["Internal Registry"]
    end

    sh -- "builds + runs" --> builder
    pw -- "browser automation" --> console
    console --> pluginpod
    pluginpod -- "gh-api-url=fakegithub.svc:8090" --> fghapi
    seed -- "admin API" --> pf
    pf -- "port-forward" --> fghapi
    fghapi --> memstore
    fghapi -- "UpdateRef triggers" --> actrunner
    actrunner --> memstore
    funcdeploy -- "s2i build" --> s2ibuild
    s2ibuild -- "push image" --> registry
    funcdeploy -- "deploy (kubeconfig secret)" --> kubeapi
    pluginpod --> kubeapi
    kubeapi --> knative
    style builder fill:#454545,stroke:#888
    style fghpod fill:#454545,stroke:#777
    style actrunner fill:#5c5b5b,stroke:#999
```

---

### make e2e (Prow CI only)

Runs inside a Prow job pod in the cluster farm. Identical cluster-side topology to `builder-run.sh make e2e`.

```mermaid
graph TB
    subgraph farm["cluster-x (from cluster farm)"]
        subgraph prow["[pod] Prow Job"]
            pw["[process]\nPlaywright\ntest suite"]
            seed["fakegithub.ts\nhelpers"]
            pf["[process]\nkubectl port-forward\nlocalhost:8090"]
        end
    end

    subgraph cluster["OpenShift Cluster (console-functions-plugin ns)"]
        subgraph fghpod["[pod] fakegithub pod"]
            fghapi["fakegithub API"]
            memstore["In-memory store"]
            subgraph actrunner["[process] act runner"]
                funcdeploy["[process]\nfunc deploy"]
                s2ibuild["[process]\nS2I build"]
            end
        end
        pluginpod["[pod]\nPlugin pod\n(backend + frontend)"]
        console["[pod]\nOCP Console"]
        kubeapi["Kube API Server"]
        knative["Knative / Functions"]
        registry["Internal Registry"]
    end

    pw -- "browser automation" --> console
    console --> pluginpod
    pluginpod -- "gh-api-url=fakegithub.svc:8090" --> fghapi
    seed -- "admin API" --> pf
    pf -- "port-forward" --> fghapi
    fghapi --> memstore
    fghapi -- "UpdateRef triggers" --> actrunner
    actrunner --> memstore
    funcdeploy -- "s2i build" --> s2ibuild
    s2ibuild -- "push image" --> registry
    funcdeploy -- "deploy (kubeconfig secret)" --> kubeapi
    pluginpod --> kubeapi
    kubeapi --> knative
    style prow fill:#454545,stroke:#777
    style fghpod fill:#454545,stroke:#777
    style actrunner fill:#5c5b5b,stroke:#999
```

---

### make deploy-dev

```mermaid
graph TB
    subgraph local["Local Machine"]
        podman["[process]\npodman build"]
        pf["[process]\nport-forward\nlocalhost:5001"]
        browser["Browser"]
    end

    subgraph gh["GitHub (cloud)"]
        ghapi[/"GitHub API\napi.github.com"/]
        ghactions[/"GitHub Actions\n(workflow runner)"/]
    end

    subgraph cluster["OpenShift Cluster"]
        intreg["Internal Registry\n:5000"]
        helm["Helm deploy\n(oc apply)"]
        pluginpod["[pod]\nPlugin pod\n(backend + frontend)"]
        console["[pod]\nOCP Console"]
        kubeapi["Kube API Server"]
        knative["Knative / Functions"]
    end

    podman -- "push via port-forward" --> pf
    pf --> intreg
    intreg --> helm
    helm --> pluginpod
    browser --> console
    console --> pluginpod
    pluginpod -- "push code,\nstore secrets" --> ghapi
    ghapi -- "push triggers" --> ghactions
    ghactions -- "func deploy\n(kubeconfig secret)" --> kubeapi
    pluginpod --> kubeapi
    kubeapi --> knative
```
