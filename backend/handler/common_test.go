package handler

import (
	"context"
	"fmt"
	"net/http"

	. "github.com/onsi/ginkgo/v2"

	"github.com/openshift/faas-console-plugin/backend/auth"
	"github.com/openshift/faas-console-plugin/backend/auth/identity"
	"github.com/openshift/faas-console-plugin/backend/cluster"
	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/functions"
	"github.com/openshift/faas-console-plugin/backend/scm"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

const (
	// testOCPToken stands in for the console user token the proxy forwards.
	testOCPToken = "ocp-token"
	// testNamespace is where the fake cluster keeps its credential Secrets.
	testNamespace = "console-functions-plugin"
)

// testOCPUser is the OpenShift user every stored credential is bound to.
var testOCPUser = identity.User{Username: "tester", UID: "tester-uid"}

// credentialCluster is the fake cluster behind the store testHandlers built
// last. A package var is enough because a spec always builds its handlers
// before it asserts on them, and specs never run concurrently within a process.
var credentialCluster *fake.Clientset

// credentialSecrets returns the Secrets the handler under test can see, for
// asserting what it stored or revoked.
func credentialSecrets() []corev1.Secret {
	list, err := credentialCluster.CoreV1().Secrets(testNamespace).List(context.Background(), metav1.ListOptions{})
	if err != nil {
		panic(err)
	}
	return list.Items
}

// testHandlers gives h a credential store holding testOCPUser's PAT, plus an
// identity resolver, so credential lookup takes the same path as production.
// The tests run against a real auth.Store over a fake cluster rather than a
// stand-in, so the ownership and expiry rules they exercise are the ones that
// ship. Pass the struct by value: callers set only the fields they care about
// and never have to remember the rest. A resolver set by the caller is kept,
// which is how a test plays a different user.
func testHandlers(h Handlers) *Handlers {
	// A cluster of its own per call, so one spec revoking a credential cannot
	// change what the next one sees.
	credentialCluster = fake.NewClientset()
	store := auth.NewStoreWithClient(credentialCluster, testNamespace)
	err := store.SaveCredential(context.Background(), testOCPUser, auth.Credential{
		Owner:  "tester",
		Secret: "test-pat",
		Type:   auth.CredentialTypePAT,
	})
	if err != nil {
		panic(fmt.Sprintf("seed test credential: %v", err))
	}
	h.credentials = store

	if h.identityResolver == nil {
		h.identityResolver = &identity.ResolverStub{
			OnResolve: func(context.Context, string) (identity.User, error) { return testOCPUser, nil },
		}
	}
	return &h
}

// authenticate marks req as coming through the console proxy, which forwards
// the user token. That identity is now the only thing a request carries: the
// credential is found by it rather than by a handle the browser holds.
func authenticate(req *http.Request) *http.Request {
	req.Header.Set("Authorization", "Bearer "+testOCPToken)
	return req
}

func withSCMStub(stub scm.Client) {
	orig := config.SCMRegistry
	config.SCMRegistry = scm.Registry{
		scm.GitHub: func(token string) scm.Client { return stub },
	}
	DeferCleanup(func() { config.SCMRegistry = orig })
}

func withClusterStub(stub cluster.Client) {
	orig := newClusterClient
	newClusterClient = func(host, token string, caCert []byte) (cluster.Client, error) {
		return stub, nil
	}
	DeferCleanup(func() { newClusterClient = orig })
}

func withFunctionsClient(stub functions.Client) {
	orig := newFunctionsClient
	newFunctionsClient = func(host, token string, caCert []byte) (functions.Client, error) {
		return stub, nil
	}
	DeferCleanup(func() { newFunctionsClient = orig })
}

func withFunctionsClientError(err error) {
	orig := newFunctionsClient
	newFunctionsClient = func(host, token string, caCert []byte) (functions.Client, error) {
		return nil, err
	}
	DeferCleanup(func() { newFunctionsClient = orig })
}
