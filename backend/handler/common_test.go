package handler

import (
	"context"
	"fmt"
	"net/http"

	. "github.com/onsi/ginkgo/v2"

	"github.com/openshift/faas-console-plugin/backend/cluster"
	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/functions"
	"github.com/openshift/faas-console-plugin/backend/identity"
	"github.com/openshift/faas-console-plugin/backend/scm"
	"github.com/openshift/faas-console-plugin/backend/session"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

const (
	// testOCPToken stands in for the console user token the proxy forwards.
	testOCPToken = "ocp-token"
	// testNamespace is where the fake cluster keeps its session Secrets.
	testNamespace = "console-functions-plugin"
)

// testOCPUser is the OpenShift user every test session is bound to.
var testOCPUser = identity.User{Username: "tester", UID: "tester-uid"}

// The handler tests run against a real session.Store over a fake cluster rather
// than a stand-in, so the ownership and expiry rules under test are the ones
// that ship. The token has to be fixed because authenticate builds requests
// before testHandlers exists, and a real store hands out a random one, so it is
// minted once here and the resulting Secret is replayed into each test's cluster.
var (
	testSessionToken  string
	testSessionSecret *corev1.Secret
)

func init() {
	client := fake.NewClientset()
	store := session.NewStoreWithClient(client, testNamespace)

	token, err := store.CreateSession(context.Background(), testOCPUser, session.Credential{
		Owner:  "tester",
		Secret: "test-pat",
		Type:   session.CredentialTypePAT,
	})
	if err != nil {
		panic(fmt.Sprintf("seed test session: %v", err))
	}
	secrets, err := client.CoreV1().Secrets(testNamespace).List(context.Background(), metav1.ListOptions{})
	if err != nil || len(secrets.Items) != 1 {
		panic(fmt.Sprintf("seed test session: got %d secrets, err %v", len(secrets.Items), err))
	}

	testSessionToken = token
	testSessionSecret = &secrets.Items[0]
}

// sessionCluster is the fake cluster behind the store testHandlers built last.
// A package var is enough because a spec always builds its handlers before it
// asserts on them, and specs never run concurrently within a process.
var sessionCluster *fake.Clientset

// sessionSecrets returns the session Secrets the handler under test can see,
// for asserting what it stored or revoked.
func sessionSecrets() []corev1.Secret {
	list, err := sessionCluster.CoreV1().Secrets(testNamespace).List(context.Background(), metav1.ListOptions{})
	if err != nil {
		panic(err)
	}
	return list.Items
}

// testHandlers gives h a session store and an identity resolver so credential
// lookup takes the same path as production. Pass the struct by value: callers
// set only the fields they care about and never have to remember the rest. A
// resolver set by the caller is kept, which is how a test plays a different user.
func testHandlers(h Handlers) *Handlers {
	// A cluster of its own per call, so one spec revoking a session cannot
	// change what the next one sees.
	sessionCluster = fake.NewClientset(testSessionSecret.DeepCopy())
	h.sessionStore = session.NewStoreWithClient(sessionCluster, testNamespace)

	if h.identityResolver == nil {
		h.identityResolver = &identity.ResolverStub{
			OnResolve: func(context.Context, string) (identity.User, error) { return testOCPUser, nil },
		}
	}
	return &h
}

// authenticate marks req as coming from a live session. Both headers are needed:
// the console proxy always forwards the user token, and the session is bound to it.
func authenticate(req *http.Request) *http.Request {
	req.Header.Set(sessionHeader, testSessionToken)
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
