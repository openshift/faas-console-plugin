// Tests verifying appropriate flag parsing and wiring.
// Tests are deliberately using "standard" Go testing suite,
// so we can use "synctest" timing sensitive tests.

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/openshift/faas-console-plugin/backend/testutil"
	authenticationv1 "k8s.io/api/authentication/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	k8sPluginToken = "plugin-sa-token"
	k8sUserName    = "alice"
	k8sUserUUID    = "alice-uuid"
	k8sUserToken   = "alice-token"
	ghUsername     = "ali"
	githubPAT      = "alice-pat"
)

func TestWorkflowWatch(t *testing.T) {

	var err error

	// Whatever can be initialized outside the synctest bubble should be.
	fakeGH := httptest.NewServer(closeConnections(fakeWorkflowGitHub()))
	t.Cleanup(fakeGH.Close)

	fakeK8S := httptest.NewUnstartedServer(closeConnections(fakeK8SSecretsAndIdentity()))
	fakeK8S.StartTLS()
	t.Cleanup(fakeK8S.Close)

	backendPort := uint16(0xdead)
	backendURL := fmt.Sprintf("http://dummy:%d", backendPort)

	tmpDir := t.TempDir()

	kubeCABundleBytes := pem.EncodeToMemory(&pem.Block{
		Type:  "CERTIFICATE",
		Bytes: fakeK8S.Certificate().Raw,
	})

	fakeK8SCA := filepath.Join(tmpDir, "kube-ca.crt")
	err = os.WriteFile(fakeK8SCA, kubeCABundleBytes, 0644)
	if err != nil {
		t.Fatal(err)
	}

	kubeConfig := filepath.Join(tmpDir, "kubeconfig")
	err = os.WriteFile(kubeConfig, []byte(testKubeConfig(fakeK8S.URL, fakeK8SCA, k8sPluginToken)), 0644)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("KUBECONFIG", kubeConfig)
	// In a CI pod the in-cluster config wins over KUBECONFIG, pointing the
	// backend at the real cluster instead of the fake one.
	t.Setenv("KUBERNETES_SERVICE_HOST", "")
	t.Setenv("KUBERNETES_SERVICE_PORT", "")

	args := []string{
		fmt.Sprintf("--http-port=%d", backendPort),
		"--gh-api-url=" + fakeGH.URL,
		"--kube-host=" + fakeK8S.URL,
		"--kube-root-ca-path=" + fakeK8SCA,
		"--external-api-server-url=https://api.dummy.example.com",
		"--workflow-polling-interval=10s",
		"--cluster-id=98c2f130-dd66-11f1-a77f-b2a99db796ec",
	}
	t.Log("backend args:", args)

	// TBF: I may remove this synctest for fake timing and do it with real timers.
	// The synctest is very, very fragile and requires additional steps like injecting listen function.
	// Since this is e2e-ish test it would be for the best to use real time with some small durations (e.g. 500ms).
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()

		var listener = testutil.NewMemListener()
		var listen = func(network, address string) (net.Listener, error) {
			if network != "tcp" {
				return nil, errors.New("bad network")
			}
			h, p, e := net.SplitHostPort(address)
			if e != nil {
				return nil, e
			}
			if h != "" {
				return nil, errors.New("bad host")
			}
			if p, e := strconv.ParseUint(p, 10, 16); e != nil || p != uint64(backendPort) {
				return nil, errors.New("bad port")
			}
			return listener, nil
		}
		var client = http.Client{
			Transport: &http.Transport{
				DialContext: listener.DialContext,
			},
		}

		var runErr error
		var runExited = make(chan struct{})
		go func() {
			defer close(runExited)
			runErr = run(ctx, args, withListen(listen))
		}()

		loginReq, err := http.NewRequestWithContext(ctx, "POST", backendURL+"/api/v1/scm/github/credential",
			strings.NewReader(fmt.Sprintf(`{"pat":%q}`, githubPAT)))
		if err != nil {
			t.Fatal(err)
		}
		loginReq.Header.Add("Authorization", "Bearer "+k8sUserToken)
		saveResp, err := client.Do(loginReq)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(saveResp.Body)
		saveResp.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if saveResp.StatusCode != http.StatusCreated {
			t.Fatalf("save credential: expected 201, got %d: %s", saveResp.StatusCode, body)
		}

		watchReq, err := http.NewRequestWithContext(ctx, "GET", backendURL+"/api/v1/func/workflow-run/watch", nil)
		if err != nil {
			t.Fatal(err)
		}
		watchReq.Header.Add("Authorization", "Bearer "+k8sUserToken)
		resp, err := client.Do(watchReq) //nolint:bodyclose // the scanner goroutine below hides the deferred close from the linter
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != 200 {
			t.Fatal("non-200 response")
		}

		var workflowRuns, appErrors atomic.Int32
		go func() {
			scanner := bufio.NewScanner(resp.Body)
			for scanner.Scan() {
				name, ok := strings.CutPrefix(scanner.Text(), "event: ")
				if !ok {
					continue
				}
				switch name {
				case "workflow-run-status":
					workflowRuns.Add(1)
				case "app-error":
					appErrors.Add(1)
				}
			}
		}()

		time.Sleep(time.Second * 9)

		if appErrors.Load() > 0 {
			t.Fatal("unexpected app-error")
		}

		if workflowRuns.Load() != 1 {
			t.Fatal("expected exactly one workflow runs event")
		}

		time.Sleep(time.Second * 2)

		if appErrors.Load() > 0 {
			t.Fatal("unexpected app-error")
		}

		if workflowRuns.Load() != 2 {
			t.Fatal("expected exactly two workflow runs event")
		}

		cancel()
		<-runExited
		if runErr != nil {
			t.Fatal(runErr)
		}
	})
}

func testKubeConfig(url, caPath, token string) string {
	return fmt.Sprintf(`
apiVersion: v1
clusters:
- cluster:
    server: %s
    certificate-authority: %s
  name: testing-cluster
contexts:
- context:
    cluster: testing-cluster
    namespace: default
    user: kube:admin/testing-cluster
  name: default/testing-cluster/kube:admin
current-context: default/testing-cluster/kube:admin
kind: Config
preferences: {}
users:
- name: kube:admin/testing-cluster
  user:
    token: %s
`, url, caPath, token)
}

func fakeWorkflowGitHub() http.Handler {
	var polls atomic.Int32
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/user":
			_ = json.NewEncoder(w).Encode(map[string]string{"login": ghUsername})
		case r.URL.Path == "/search/repositories":
			_ = json.NewEncoder(w).Encode(map[string]any{"total_count": 1, "items": []map[string]any{{
				"name":           "fn",
				"html_url":       "https://example.com/" + ghUsername + "/fn",
				"default_branch": "main",
				"owner":          map[string]any{"login": ghUsername},
			}}})
		case strings.Contains(r.URL.Path, "/actions/workflows/"):
			run := map[string]any{"id": 1, "status": "completed", "conclusion": "success"}
			if polls.Add(1) == 1 {
				run = map[string]any{"id": 1, "status": "in_progress"}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"total_count": 1, "workflow_runs": []any{run}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
}

// fakeK8SSecretsAndIdentity serves the slice of the Kubernetes API the backend
// uses: the identity review, and the Secrets holding SCM credentials. The
// Secrets live in a map rather than being fabricated per request, so what the
// backend writes is what it reads back, and credentials.Store's own naming and
// payload rules are exercised instead of imitated.
func fakeK8SSecretsAndIdentity() http.Handler {
	var mu sync.Mutex
	secrets := make(map[string]*corev1.Secret)
	key := func(namespace, name string) string { return namespace + "/" + name }

	// The Secret routes are the plugin's own ServiceAccount talking, not the user's.
	requireSAToken := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer "+k8sPluginToken {
				writeK8SStatus(w, http.StatusUnauthorized, metav1.StatusReasonUnauthorized, "bad plugin service account token")
				return
			}
			next(w, r)
		}
	}

	decodeSecret := func(w http.ResponseWriter, r *http.Request) *corev1.Secret {
		secret := new(corev1.Secret)
		if err := json.NewDecoder(r.Body).Decode(secret); err != nil {
			writeK8SStatus(w, http.StatusBadRequest, metav1.StatusReasonBadRequest, err.Error())
			return nil
		}
		secret.TypeMeta = metav1.TypeMeta{APIVersion: "v1", Kind: "Secret"}
		secret.Namespace = r.PathValue("namespace")
		return secret
	}

	mux := http.NewServeMux()

	mux.HandleFunc("POST /apis/authentication.k8s.io/v1/selfsubjectreviews", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+k8sUserToken {
			// A Status body is what makes apierrors.IsUnauthorized true,
			// and that is what turns into a 401 on the SSE stream.
			writeK8SStatus(w, http.StatusUnauthorized, metav1.StatusReasonUnauthorized, "bad user token")
			return
		}
		writeK8SObject(w, http.StatusOK, &authenticationv1.SelfSubjectReview{
			TypeMeta: metav1.TypeMeta{APIVersion: "authentication.k8s.io/v1", Kind: "SelfSubjectReview"},
			Status: authenticationv1.SelfSubjectReviewStatus{
				UserInfo: authenticationv1.UserInfo{Username: k8sUserName, UID: k8sUserUUID},
			},
		})
	})

	mux.HandleFunc("POST /api/v1/namespaces/{namespace}/secrets", requireSAToken(func(w http.ResponseWriter, r *http.Request) {
		secret := decodeSecret(w, r)
		if secret == nil {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		k := key(secret.Namespace, secret.Name)
		if _, ok := secrets[k]; ok {
			// AlreadyExists is what sends credentials.Store down its update path.
			writeK8SStatus(w, http.StatusConflict, metav1.StatusReasonAlreadyExists,
				fmt.Sprintf("secrets %q already exists", secret.Name))
			return
		}
		secrets[k] = secret
		writeK8SObject(w, http.StatusCreated, secret)
	}))

	mux.HandleFunc("PUT /api/v1/namespaces/{namespace}/secrets/{name}", requireSAToken(func(w http.ResponseWriter, r *http.Request) {
		secret := decodeSecret(w, r)
		if secret == nil {
			return
		}
		secret.Name = r.PathValue("name")
		mu.Lock()
		defer mu.Unlock()
		k := key(secret.Namespace, secret.Name)
		if _, ok := secrets[k]; !ok {
			writeK8SStatus(w, http.StatusNotFound, metav1.StatusReasonNotFound,
				fmt.Sprintf("secrets %q not found", secret.Name))
			return
		}
		secrets[k] = secret
		writeK8SObject(w, http.StatusOK, secret)
	}))

	mux.HandleFunc("GET /api/v1/namespaces/{namespace}/secrets/{name}", requireSAToken(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		secret, ok := secrets[key(r.PathValue("namespace"), r.PathValue("name"))]
		if !ok {
			writeK8SStatus(w, http.StatusNotFound, metav1.StatusReasonNotFound,
				fmt.Sprintf("secrets %q not found", r.PathValue("name")))
			return
		}
		writeK8SObject(w, http.StatusOK, secret)
	}))

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeK8SStatus(w, http.StatusNotFound, metav1.StatusReasonNotFound,
			fmt.Sprintf("unexpected %s %s", r.Method, r.URL.Path))
	})

	return mux
}

// closeConnections makes every response close its connection. Within
// synctest.Test a goroutine parked on a kept-alive socket is not durably
// blocked, so the bubble never goes idle, the fake clock never advances, and
// the test's sleeps never return.
func closeConnections(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Connection", "close")
		next.ServeHTTP(w, r)
	})
}

func writeK8SObject(w http.ResponseWriter, code int, obj any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(obj)
}

func writeK8SStatus(w http.ResponseWriter, code int, reason metav1.StatusReason, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(&metav1.Status{
		TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Status"},
		Status:   metav1.StatusFailure,
		Code:     int32(code),
		Reason:   reason,
		Message:  message,
	})
}
