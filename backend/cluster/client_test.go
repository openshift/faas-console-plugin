package cluster

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

func newClient(handler http.HandlerFunc) Client {
	srv := httptest.NewServer(handler)
	DeferCleanup(srv.Close)
	cl, err := New("test-token", srv.URL, nil, 0)
	Expect(err).NotTo(HaveOccurred())
	return cl
}

func assertAuth(r *http.Request) {
	Expect(r.Header.Get("Authorization")).To(Equal("Bearer test-token"))
}

// jsonOK writes a 200 JSON response (or the provided code) with Content-Type set.
func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeStatus(w http.ResponseWriter, code int, reason, message string) {
	writeJSON(w, code, map[string]any{
		"kind":    "Status",
		"reason":  reason,
		"message": message,
		"code":    code,
	})
}

var _ = Describe("Kubernetes cluster client", func() {

	Describe("CreateServiceAccount", func() {
		It("creates the service account in the namespace", func() {
			called := false
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				defer GinkgoRecover()
				assertAuth(r)
				Expect(r.Method).To(Equal(http.MethodPost))
				Expect(r.URL.Path).To(ContainSubstring("/serviceaccounts"))
				called = true
				writeJSON(w, http.StatusCreated, map[string]any{})
			})

			Expect(cl.CreateServiceAccount(context.Background(), "default")).To(Succeed())
			Expect(called).To(BeTrue())
		})

		It("succeeds when the service account already exists", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				writeStatus(w, http.StatusConflict, "AlreadyExists", "already exists")
			})

			Expect(cl.CreateServiceAccount(context.Background(), "default")).To(Succeed())
		})

		It("returns an error for non-conflict failures", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				writeStatus(w, http.StatusForbidden, "Forbidden", "forbidden")
			})

			Expect(cl.CreateServiceAccount(context.Background(), "default")).NotTo(Succeed())
		})
	})

	Describe("ApplyRole", func() {
		It("creates the role with the required permissions when it does not exist", func() {
			var capturedResources []string
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost {
					var body map[string]any
					json.NewDecoder(r.Body).Decode(&body)
					for _, rule := range body["rules"].([]any) {
						for _, res := range rule.(map[string]any)["resources"].([]any) {
							capturedResources = append(capturedResources, res.(string))
						}
					}
					writeJSON(w, http.StatusCreated, map[string]any{})
				}
			})

			Expect(cl.ApplyRole(context.Background(), "default")).To(Succeed())
			Expect(capturedResources).To(ContainElements("pods", "pods/exec", "services", "configmaps"))
		})

		It("updates the role when it already exists, forwarding the existing resourceVersion", func() {
			var capturedResourceVersion string
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				switch r.Method {
				case http.MethodPost:
					writeStatus(w, http.StatusConflict, "AlreadyExists", "already exists")
				case http.MethodGet:
					writeJSON(w, http.StatusOK, map[string]any{
						"metadata": map[string]string{"name": roleName, "resourceVersion": "42"},
						"rules":    []any{},
					})
				case http.MethodPut:
					var body map[string]any
					json.NewDecoder(r.Body).Decode(&body)
					if meta, ok := body["metadata"].(map[string]any); ok {
						capturedResourceVersion, _ = meta["resourceVersion"].(string)
					}
					writeJSON(w, http.StatusOK, map[string]any{})
				}
			})

			Expect(cl.ApplyRole(context.Background(), "default")).To(Succeed())
			Expect(capturedResourceVersion).To(Equal("42"))
		})
	})

	Describe("CreateRoleBinding", func() {
		It("sends a POST to the rolebindings endpoint", func() {
			postCalled := false
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost && strings.Contains(r.URL.Path, "rolebindings") {
					postCalled = true
				}
				writeJSON(w, http.StatusCreated, map[string]any{})
			})

			Expect(cl.CreateRoleBinding(context.Background(), "default")).To(Succeed())
			Expect(postCalled).To(BeTrue())
		})

		It("succeeds when the binding already exists", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				writeStatus(w, http.StatusConflict, "AlreadyExists", "already exists")
			})

			Expect(cl.CreateRoleBinding(context.Background(), "default")).To(Succeed())
		})

		It("returns an error for non-conflict failures", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				writeStatus(w, http.StatusForbidden, "Forbidden", "forbidden")
			})

			Expect(cl.CreateRoleBinding(context.Background(), "default")).NotTo(Succeed())
		})
	})

	Describe("CreateImageBuilderBinding", func() {
		It("sends a POST to the rolebindings endpoint for the image-builder binding", func() {
			postCalled := false
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost && strings.Contains(r.URL.Path, "rolebindings") {
					postCalled = true
				}
				writeJSON(w, http.StatusCreated, map[string]any{})
			})

			Expect(cl.CreateImageBuilderBinding(context.Background(), "default")).To(Succeed())
			Expect(postCalled).To(BeTrue())
		})

		It("returns an error for non-conflict failures", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				writeStatus(w, http.StatusForbidden, "Forbidden", "forbidden")
			})

			Expect(cl.CreateImageBuilderBinding(context.Background(), "default")).NotTo(Succeed())
		})
	})

	Describe("RequestToken", func() {
		It("returns a bound service account token", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				defer GinkgoRecover()
				assertAuth(r)
				Expect(r.URL.Path).To(ContainSubstring("/token"))
				writeJSON(w, http.StatusCreated, map[string]any{
					"status": map[string]any{
						"token":               "sa-token-value",
						"expirationTimestamp": "2026-10-18T14:30:00Z",
					},
				})
			})

			token, err := cl.RequestToken(context.Background(), "default")

			Expect(err).NotTo(HaveOccurred())
			Expect(token).To(Equal("sa-token-value"))
		})

		It("returns an error when the token endpoint is unavailable", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				writeStatus(w, http.StatusForbidden, "Forbidden", "forbidden")
			})

			_, err := cl.RequestToken(context.Background(), "default")

			Expect(err).To(HaveOccurred())
		})
	})

})
