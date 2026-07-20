---
allowed-tools: Bash(oc whoami*), Bash(oc get *), Bash(oc create *), Bash(oc apply *), Bash(oc new-project *), Bash(oc project *), Bash(oc delete pipelinerun *), Bash(func create *), Bash(func deploy *), Bash(func info *), Bash(func version*), Bash(command -v *), Bash(ls *), Bash(cat *), Bash(test *), Bash(pwd), Bash(for *), Bash(brew install *), Bash(brew tap *), Bash(brew trust *), Bash(gcloud auth *), Bash(cp demo/pdf-transcriber/*), Bash(rm -f pdf-transcriber/src/*), Bash(sleep *), Bash(printenv *), Bash(echo $*), Read, Edit, AskUserQuestion
description: Deploy the PDF transcriber demo to an OpenShift cluster
---

# Deploy PDF Transcriber Demo (Full E2E)

Walk the user through the full end-to-end flow: install prerequisites, log into a cluster, scaffold the function, install operators, and deploy. Run each step, check the result, and report clearly before moving on. If a step fails, explain what went wrong and how to fix it. Do not barrel through failures.

## Variables

Before starting, check if `demo/pdf-transcriber/.env` exists. If it does not, copy `demo/pdf-transcriber/.env.example` to `demo/pdf-transcriber/.env` and ask the user to fill in the values. Then read `demo/pdf-transcriber/.env` to load `ANTHROPIC_VERTEX_PROJECT_ID` and `CLOUD_ML_REGION`. If either value is empty, ask the user to fill them in and re-read. Do not proceed without values for both.

- NAMESPACE: `pdf-transcriber`
- ADC_FILE: `$HOME/.config/gcloud/application_default_credentials.json`
- GCP_PROJECT: `ANTHROPIC_VERTEX_PROJECT_ID` from `demo/pdf-transcriber/.env`
- GCP_REGION: `CLOUD_ML_REGION` from `demo/pdf-transcriber/.env`
- DEMO_DIR: `demo/pdf-transcriber`
- PROJECT_DIR: `pdf-transcriber`

---

## Phase 1: Prerequisites

Check each tool. Install anything missing via Homebrew. Report a summary table at the end.

### 1.1 Knative func CLI

Check `command -v func`. If missing:
```sh
brew tap knative-sandbox/kn-plugins
brew trust knative-sandbox/kn-plugins
brew install func
```

### 1.2 Google Cloud SDK

Check `command -v gcloud`. If missing:
```sh
brew install google-cloud-sdk
```

### 1.3 oc CLI

Check `command -v oc`. If missing, tell the user to install it from https://console.redhat.com/openshift/downloads and stop.

### 1.4 Google Cloud auth

Check if the user is logged into gcloud:
```sh
gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null
```

If no active account, ask the user to run `gcloud auth login` in a separate terminal (it opens a browser for OAuth). Wait for them to confirm before continuing.

### 1.5 GCP Application Default Credentials

Check if `$HOME/.config/gcloud/application_default_credentials.json` exists. If missing, ask the user to run `gcloud auth application-default login` in a separate terminal. This is a separate auth step from `gcloud auth login`. The ADC file is what the Java SDK uses and gets mounted as a secret on the cluster. Wait for them to confirm before continuing.

---

## Phase 2: Cluster Login

### 2.1 Check login

Run `oc whoami` and `oc whoami --show-server`.

- If logged in, show the user and server, ask if this is the right cluster.
- If not logged in, ask the user for their cluster API URL and tell them to run `oc login <url>` in a separate terminal (interactive login needs their terminal). Wait for them to confirm before continuing.

---

## Phase 3: Scaffold the Function

### 3.1 Check if project already exists

Check if `pdf-transcriber/func.yaml` exists in the repo root.

- If it exists, tell the user the project is already scaffolded and skip to Phase 4.
- If not, continue with scaffolding.

### 3.2 Scaffold with func CLI

From the repo root:
```sh
func create -l quarkus -t http pdf-transcriber
```

### 3.3 Copy demo files

```sh
cp demo/pdf-transcriber/Function.java pdf-transcriber/src/main/java/functions/Function.java
cp demo/pdf-transcriber/pom.xml pdf-transcriber/pom.xml
cp demo/pdf-transcriber/application.properties pdf-transcriber/src/main/resources/application.properties
```

### 3.4 Remove scaffolded files

```sh
rm -f pdf-transcriber/src/main/java/functions/Input.java pdf-transcriber/src/main/java/functions/Output.java
rm -f pdf-transcriber/src/test/java/functions/FunctionTest.java pdf-transcriber/src/test/java/functions/NativeFunctionIT.java
```

### 3.5 Patch func.yaml for cluster deployment

Do NOT rewrite `func.yaml` from scratch. The `func` CLI generates fields like `created` during scaffold that it requires to recognize the project. Instead, read the existing `func.yaml` and patch in only the fields needed for cluster deployment:

- Set `registry: image-registry.openshift-image-registry.svc:5000/pdf-transcriber`
- Set `build.builder: s2i`
- Add these to `build.buildEnvs` if not already present:
  - `MAVEN_S2I_ARTIFACT_DIRS` = `target/quarkus-app`
  - `S2I_SOURCE_DEPLOYMENTS_FILTER` = `lib quarkus-run.jar app quarkus`
- Add `run.volumes` with the GCP secret mount:
  - `secret: gcp-adc`, `path: /var/secrets/google`
- Add these to `run.envs` if not already present:
  - `ANTHROPIC_VERTEX_PROJECT_ID` = value loaded from `demo/pdf-transcriber/.env`
  - `CLOUD_ML_REGION` = value loaded from `demo/pdf-transcriber/.env`
  - `GOOGLE_APPLICATION_CREDENTIALS` = `/var/secrets/google/application_default_credentials.json`

Show the user the planned changes and confirm before editing.

---

## Phase 4: Install Operators

### 4.1 OpenShift Serverless operator

First check if already installed:
```sh
oc get csv -A 2>/dev/null | grep -i serverless | grep Succeeded
```

If already `Succeeded`, skip to 4.2.

Otherwise, check if the `openshift-serverless` namespace and an OperatorGroup already exist:
```sh
oc get operatorgroups -n openshift-serverless 2>/dev/null
```

Only create the namespace and OperatorGroup if they don't exist:
```sh
oc create namespace openshift-serverless 2>/dev/null || true
```

Only apply the OperatorGroup if none exists in the namespace:
```sh
oc apply -f - <<EOF
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: serverless-operators
  namespace: openshift-serverless
spec: {}
EOF
```

Apply the Subscription:
```sh
oc apply -f - <<EOF
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: serverless-operator
  namespace: openshift-serverless
spec:
  channel: stable
  name: serverless-operator
  source: redhat-operators
  sourceNamespace: openshift-marketplace
EOF
```

Poll until the CSV shows `Succeeded` (every 10s, up to 5 minutes). Give progress updates showing the current phase. If it reaches `Failed`, check the CSV message for the reason and report it to the user.

### 4.2 KnativeServing

First check if already ready:
```sh
oc get knativeserving knative-serving -n knative-serving -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null
```

If `True`, skip.

Otherwise:
```sh
oc create namespace knative-serving 2>/dev/null || true
oc apply -f - <<EOF
apiVersion: operator.knative.dev/v1beta1
kind: KnativeServing
metadata:
  name: knative-serving
  namespace: knative-serving
spec: {}
EOF
```

Poll until Ready (every 10s, up to 5 minutes).

### 4.3 OpenShift Pipelines operator

First check if already installed:
```sh
oc get csv -A 2>/dev/null | grep -i pipelines | grep Succeeded
```

If already `Succeeded`, skip.

Otherwise:
```sh
oc apply -f - <<EOF
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: openshift-pipelines-operator-rh
  namespace: openshift-operators
spec:
  channel: latest
  name: openshift-pipelines-operator-rh
  source: redhat-operators
  sourceNamespace: openshift-marketplace
EOF
```

Poll until the Pipelines CSV shows `Succeeded` (every 10s, up to 5 minutes).

---

## Phase 5: Namespace and Secrets

### 5.1 Create namespace

```sh
oc new-project pdf-transcriber 2>/dev/null || oc project pdf-transcriber
```

### 5.2 Create GCP credentials secret

```sh
oc create secret generic gcp-adc \
  --from-file=application_default_credentials.json=$HOME/.config/gcloud/application_default_credentials.json \
  -n pdf-transcriber 2>/dev/null || echo "Secret gcp-adc already exists."
```

### 5.3 Wait for pipeline ServiceAccount

The Pipelines operator automatically creates a `pipeline` ServiceAccount in every namespace, but it can take a few seconds after namespace creation. Tekton builds fail with `PodCreationFailed` if this SA is missing. Poll until it exists before deploying:

```sh
oc get sa pipeline -n pdf-transcriber
```

Poll every 5 seconds, up to 1 minute. If it doesn't appear, tell the user the Pipelines operator may not be reconciling and suggest checking `oc get csv -A | grep pipelines`.

---

## Phase 6: Deploy

### 6.1 Run func deploy

From the `pdf-transcriber/` directory:
```sh
func deploy --remote --namespace pdf-transcriber
```

Tell the user this builds on-cluster via Tekton (needed because local builds on Apple Silicon produce ARM images). This step can take several minutes.

### 6.2 Handle failure and retry

If `func deploy` fails, check the pipeline run for the failure reason:
```sh
oc get pipelinerun -n pdf-transcriber
```

Common failures:
- **PodCreationFailed / SA "pipeline" not found**: the pipeline SA was not ready. Wait for it (step 5.3), then clean up the failed run and retry:
  ```sh
  oc delete pipelinerun --all -n pdf-transcriber
  func deploy --remote --namespace pdf-transcriber
  ```
- **Build errors**: check task run logs for compilation or image build failures.
- **Operator issues**: check `oc get csv -A` for unhealthy operators.

### 6.3 Report

When `func deploy` finishes, report the function URL. Tell the user to open it in a browser to upload a PDF.
