package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"

	"github.com/openshift/faas-console-plugin/backend/fakegithub"
)

func main() {
	port := flag.Int("port", 8090, "HTTP server port")
	login := flag.String("login", "e2e-user", "GitHub login name for the fake user")
	pat := flag.String("pat", "placeholder-pat", "personal access token required for API authentication")
	flag.Parse()

	srv := fakegithub.New(fakegithub.User{Login: *login}, *pat)
	addr := fmt.Sprintf(":%d", *port)
	log.Printf("Fake GitHub server listening on http://localhost%s (user: %s)", addr, *login)
	log.Fatal(http.ListenAndServe(addr, srv))
}
