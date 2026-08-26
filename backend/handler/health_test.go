package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("GET /healthz", func() {
	It("returns 200 with status ok", func() {
		req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		w := httptest.NewRecorder()
		(&Handlers{}).HandleHealthz(w, req)

		Expect(w.Code).To(Equal(http.StatusOK))
		Expect(w.Header().Get("Content-Type")).To(Equal("application/json"))
		var body map[string]string
		Expect(json.NewDecoder(w.Body).Decode(&body)).To(Succeed())
		Expect(body["status"]).To(Equal("ok"))
	})
})
