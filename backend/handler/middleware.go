package handler

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/openshift/faas-console-plugin/backend/scm/credentials"
)

type ocpTokenKey struct{}

type credentialKey struct{}

type requestCredential struct {
	credentials.Credential
	ocpToken string
}

// RequireOCPToken answers "is the caller authenticated?": it rejects a request
// without the console user's bearer token and hands the token on.
func RequireOCPToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ocpToken, ok := extractOCPToken(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "authentication required")
			return
		}
		ctx := context.WithValue(r.Context(), ocpTokenKey{}, ocpToken)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RequireSCMCredential answers "has the caller connected to GitHub?" for routes
// that cannot work without a stored credential. It must run behind
// RequireOCPToken.
func RequireSCMCredential(next http.Handler, scmCredentials credentials.Provider) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ocpToken := ocpTokenFrom(r.Context())
		credential, err := scmCredentials.Get(r.Context(), ocpToken)
		if err != nil {
			writeAuthError(w, err)
			return
		}
		ctx := context.WithValue(r.Context(), credentialKey{}, requestCredential{Credential: credential, ocpToken: ocpToken})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// LoggingMiddleware logs every request and turns a panic into a 500.
func LoggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s %s", r.RemoteAddr, r.Method, r.URL.Path)
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("panic: %v", rec)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(map[string]string{"message": "internal server error"})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func ocpTokenFrom(ctx context.Context) string {
	return ctx.Value(ocpTokenKey{}).(string)
}

func credentialFrom(ctx context.Context) requestCredential {
	return ctx.Value(credentialKey{}).(requestCredential)
}

func extractOCPToken(r *http.Request) (string, bool) {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return "", false
	}
	token := strings.TrimPrefix(header, "Bearer ")
	return token, token != ""
}
