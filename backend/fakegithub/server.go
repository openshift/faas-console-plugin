package fakegithub

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/crypto/nacl/box"
)

// User configures the authenticated identity returned by the fake server.
type User struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatar_url"`
}

type repo struct {
	Owner         string
	Name          string
	DefaultBranch string
	Topics        []string
	Files         map[string]string // path -> content (source of truth)
	Blobs         map[string]string // sha -> content
	Trees         map[string][]treeEntry
	Commits       map[string]*commit
	Refs          map[string]string // "refs/heads/main" -> commit sha
	Secrets       map[string]string // name -> encrypted value
	Runs          []workflowRun     // scripted GitHub Actions runs, most recent last
}

type workflowRun struct {
	ID         int64         `json:"id"`
	HeadBranch string        `json:"head_branch"`
	HeadSHA    string        `json:"head_sha"`
	Status     string        `json:"status"`     // queued | in_progress | completed
	Conclusion string        `json:"conclusion"` // success | failure | cancelled | timed_out | ""
	HTMLURL    string        `json:"html_url"`
	Jobs       []workflowJob `json:"-"` // returned by the jobs endpoint, not the runs listing
}

type workflowJob struct {
	ID         int64          `json:"id"`
	Name       string         `json:"name"`
	Status     string         `json:"status"`
	Conclusion string         `json:"conclusion"`
	Steps      []workflowStep `json:"steps"`
}

type workflowStep struct {
	Name       string `json:"name"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	Number     int    `json:"number"`
}

type treeEntry struct {
	Path string `json:"path"`
	Mode string `json:"mode"`
	Type string `json:"type"`
	SHA  string `json:"sha"`
	Size int    `json:"size,omitempty"`
}

type commit struct {
	SHA     string `json:"sha"`
	Message string `json:"message"`
	Tree    struct {
		SHA string `json:"sha"`
	} `json:"tree"`
	Parents []struct {
		SHA string `json:"sha"`
	} `json:"parents"`
}

// Server is a fake GitHub API HTTP server with in-memory state.
type Server struct {
	mu    sync.Mutex
	user  User
	pat   string           // required PAT for API routes (empty = no auth check)
	repos map[string]*repo // "owner/name" -> repo

	pubKey    [32]byte
	privKey   [32]byte
	pubKeyB64 string
	keyID     string

	runIDSeq int64 // monotonic id source for scripted workflow runs

	mux *http.ServeMux
}

// New creates a fake GitHub server with the given user identity.
// It generates a NaCl key pair for the secrets endpoint.
// If pat is non-empty, API routes require Authorization: token <pat>.
func New(user User, pat string) *Server {
	var pub, priv [32]byte
	pubPtr, privPtr, err := box.GenerateKey(rand.Reader)
	if err != nil {
		panic(fmt.Sprintf("fakegithub: generate key pair: %v", err))
	}
	pub = *pubPtr
	priv = *privPtr

	s := &Server{
		user:      user,
		pat:       pat,
		repos:     make(map[string]*repo),
		pubKey:    pub,
		privKey:   priv,
		pubKeyB64: base64.StdEncoding.EncodeToString(pub[:]),
		keyID:     "fakegithub-key-id",
		mux:       http.NewServeMux(),
	}
	s.routes()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	log.Printf("[fakegithub] %s %s", r.Method, r.URL.Path)
	if s.pat != "" && !strings.HasPrefix(r.URL.Path, "/_admin/") {
		auth := r.Header.Get("Authorization")
		if auth != "token "+s.pat && auth != "Bearer "+s.pat {
			writeJSON(w, http.StatusUnauthorized, map[string]string{
				"message": "Bad credentials",
			})
			return
		}
	}
	s.mux.ServeHTTP(w, r)
}

func (s *Server) routes() {
	// GitHub API endpoints
	s.mux.HandleFunc("GET /user", s.handleGetUser)
	s.mux.HandleFunc("GET /search/repositories", s.handleSearchRepos)
	s.mux.HandleFunc("POST /user/repos", s.handleCreateRepo)
	s.mux.HandleFunc("GET /repos/{owner}/{repo}", s.handleGetRepo)
	s.mux.HandleFunc("DELETE /repos/{owner}/{repo}", s.handleDeleteRepo)
	s.mux.HandleFunc("POST /repos/{owner}/{repo}/branches/{branch}/rename", s.handleRenameBranch)
	s.mux.HandleFunc("PUT /repos/{owner}/{repo}/topics", s.handleReplaceTopics)

	// Contents API
	s.mux.HandleFunc("GET /repos/{owner}/{repo}/contents/{path...}", s.handleGetContents)

	// Git Data API
	s.mux.HandleFunc("GET /repos/{owner}/{repo}/git/trees/{sha}", s.handleGetTree)
	s.mux.HandleFunc("GET /repos/{owner}/{repo}/git/blobs/{sha}", s.handleGetBlob)
	s.mux.HandleFunc("POST /repos/{owner}/{repo}/git/blobs", s.handleCreateBlob)
	s.mux.HandleFunc("POST /repos/{owner}/{repo}/git/trees", s.handleCreateTree)
	s.mux.HandleFunc("POST /repos/{owner}/{repo}/git/commits", s.handleCreateCommit)
	s.mux.HandleFunc("GET /repos/{owner}/{repo}/git/ref/heads/{branch}", s.handleGetRef)
	s.mux.HandleFunc("PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}", s.handleUpdateRef)
	s.mux.HandleFunc("GET /repos/{owner}/{repo}/git/commits/{sha}", s.handleGetCommitBySHA)

	// Actions secrets
	s.mux.HandleFunc("GET /repos/{owner}/{repo}/actions/secrets/public-key", s.handleGetPublicKey)
	s.mux.HandleFunc("PUT /repos/{owner}/{repo}/actions/secrets/{name}", s.handlePutSecret)

	// Actions runs (build status). The client scopes build status to a single
	// workflow file via the by-file-name endpoint; the repo-wide endpoint is kept
	// for completeness. Both serve the same scripted runs.
	s.mux.HandleFunc("GET /repos/{owner}/{repo}/actions/runs", s.handleListWorkflowRuns)
	s.mux.HandleFunc("GET /repos/{owner}/{repo}/actions/workflows/{workflow}/runs", s.handleListWorkflowRuns)
	s.mux.HandleFunc("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", s.handleListWorkflowJobs)

	// Admin API (for test setup)
	s.mux.HandleFunc("POST /_admin/seed", s.handleAdminSeed)
	s.mux.HandleFunc("POST /_admin/reset", s.handleAdminReset)
	s.mux.HandleFunc("POST /_admin/actions/runs", s.handleAdminSetRun)
}

// --- GitHub API handlers ---

func (s *Server) handleGetUser(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	writeJSON(w, http.StatusOK, s.user)
}

func (s *Server) handleSearchRepos(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	q := r.URL.Query().Get("q")
	var items []map[string]any
	for _, rp := range s.repos {
		if !matchesSearchQuery(q, rp) {
			continue
		}
		items = append(items, repoJSON(rp))
	}
	// Sort by name for deterministic output.
	sort.Slice(items, func(i, j int) bool {
		return items[i]["name"].(string) < items[j]["name"].(string)
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"total_count": len(items),
		"items":       items,
	})
}

func (s *Server) handleCreateRepo(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var body struct {
		Name     string `json:"name"`
		AutoInit bool   `json:"auto_init"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	key := s.user.Login + "/" + body.Name
	if _, exists := s.repos[key]; exists {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"message": "Repository creation failed.",
			"errors": []map[string]string{
				{"resource": "Repository", "code": "custom", "field": "name", "message": "name already exists on this account"},
			},
		})
		return
	}

	rp := &repo{
		Owner:         s.user.Login,
		Name:          body.Name,
		DefaultBranch: "main",
		Files:         make(map[string]string),
		Blobs:         make(map[string]string),
		Trees:         make(map[string][]treeEntry),
		Commits:       make(map[string]*commit),
		Refs:          make(map[string]string),
		Secrets:       make(map[string]string),
	}

	if body.AutoInit {
		rp.Files["README.md"] = "# " + body.Name + "\n"
		buildGitObjects(rp)
	}

	s.repos[key] = rp
	writeJSON(w, http.StatusCreated, repoJSON(rp))
}

func (s *Server) handleGetRepo(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rp := s.getRepo(r)
	if rp == nil {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}
	writeJSON(w, http.StatusOK, repoJSON(rp))
}

func (s *Server) handleDeleteRepo(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	owner := r.PathValue("owner")
	name := r.PathValue("repo")
	key := owner + "/" + name
	if _, exists := s.repos[key]; !exists {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}
	delete(s.repos, key)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRenameBranch(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rp := s.getRepo(r)
	if rp == nil {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	oldBranch := r.PathValue("branch")
	var body struct {
		NewName string `json:"new_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	oldRef := "refs/heads/" + oldBranch
	sha, ok := rp.Refs[oldRef]
	if !ok {
		writeError(w, http.StatusNotFound, fmt.Sprintf("branch %q not found", oldBranch))
		return
	}

	newRef := "refs/heads/" + body.NewName
	rp.Refs[newRef] = sha
	delete(rp.Refs, oldRef)
	rp.DefaultBranch = body.NewName

	writeJSON(w, http.StatusOK, map[string]string{"name": body.NewName})
}

func (s *Server) handleReplaceTopics(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rp := s.getRepo(r)
	if rp == nil {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	var body struct {
		Names []string `json:"names"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	rp.Topics = body.Names
	writeJSON(w, http.StatusOK, map[string][]string{"names": rp.Topics})
}

func (s *Server) handleGetContents(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rp := s.getRepo(r)
	if rp == nil {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	filePath := r.PathValue("path")
	content, ok := rp.Files[filePath]
	if !ok {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	encoded := base64.StdEncoding.EncodeToString([]byte(content))
	sha := blobSHA(content)
	writeJSON(w, http.StatusOK, map[string]any{
		"type":     "file",
		"encoding": "base64",
		"size":     len(content),
		"name":     filePath[strings.LastIndex(filePath, "/")+1:],
		"path":     filePath,
		"content":  encoded,
		"sha":      sha,
	})
}

func (s *Server) handleGetTree(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rp := s.getRepo(r)
	if rp == nil {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	sha := r.PathValue("sha")
	treeSHA := resolveToTreeSHA(rp, sha)
	if treeSHA == "" {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	entries := rp.Trees[treeSHA]
	writeJSON(w, http.StatusOK, map[string]any{
		"sha":       treeSHA,
		"tree":      entries,
		"truncated": false,
	})
}

func (s *Server) handleGetBlob(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rp := s.getRepo(r)
	if rp == nil {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	sha := r.PathValue("sha")
	content, ok := rp.Blobs[sha]
	if !ok {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	encoded := base64.StdEncoding.EncodeToString([]byte(content))
	writeJSON(w, http.StatusOK, map[string]any{
		"sha":      sha,
		"content":  encoded,
		"encoding": "base64",
		"size":     len(content),
	})
}

func (s *Server) handleCreateBlob(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rp := s.getRepo(r)
	if rp == nil {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	var body struct {
		Content  string `json:"content"`
		Encoding string `json:"encoding"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	content := body.Content
	if body.Encoding == "base64" {
		decoded, err := base64.StdEncoding.DecodeString(body.Content)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid base64 content")
			return
		}
		content = string(decoded)
	}

	sha := blobSHA(content)
	rp.Blobs[sha] = content
	writeJSON(w, http.StatusCreated, map[string]string{"sha": sha})
}

func (s *Server) handleCreateTree(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rp := s.getRepo(r)
	if rp == nil {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	var body struct {
		BaseTree string      `json:"base_tree"`
		Tree     []treeEntry `json:"tree"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Merge with base tree if provided.
	merged := make(map[string]treeEntry)
	if body.BaseTree != "" {
		if base, ok := rp.Trees[body.BaseTree]; ok {
			for _, e := range base {
				merged[e.Path] = e
			}
		}
	}
	for _, e := range body.Tree {
		merged[e.Path] = e
	}

	var entries []treeEntry
	for _, e := range merged {
		entries = append(entries, e)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })

	sha := treeSHA(entries)
	rp.Trees[sha] = entries
	writeJSON(w, http.StatusCreated, map[string]any{
		"sha":  sha,
		"tree": entries,
	})
}

func (s *Server) handleCreateCommit(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rp := s.getRepo(r)
	if rp == nil {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	var body struct {
		Message string   `json:"message"`
		Tree    string   `json:"tree"`
		Parents []string `json:"parents"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	sha := commitSHA(body.Message, body.Tree, body.Parents)
	c := &commit{
		SHA:     sha,
		Message: body.Message,
	}
	c.Tree.SHA = body.Tree
	for _, p := range body.Parents {
		c.Parents = append(c.Parents, struct {
			SHA string `json:"sha"`
		}{SHA: p})
	}
	rp.Commits[sha] = c

	// Update files from tree to keep Files in sync.
	if entries, ok := rp.Trees[body.Tree]; ok {
		rp.Files = make(map[string]string)
		for _, e := range entries {
			if content, bok := rp.Blobs[e.SHA]; bok {
				rp.Files[e.Path] = content
			}
		}
	}

	writeJSON(w, http.StatusCreated, c)
}

func (s *Server) handleGetRef(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rp := s.getRepo(r)
	if rp == nil {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	branch := r.PathValue("branch")
	ref := "refs/heads/" + branch
	sha, ok := rp.Refs[ref]
	if !ok {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ref": ref,
		"object": map[string]string{
			"sha":  sha,
			"type": "commit",
		},
	})
}

func (s *Server) handleUpdateRef(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rp := s.getRepo(r)
	if rp == nil {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	branch := r.PathValue("branch")
	ref := "refs/heads/" + branch
	if _, ok := rp.Refs[ref]; !ok {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	var body struct {
		SHA   string `json:"sha"`
		Force bool   `json:"force"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	rp.Refs[ref] = body.SHA

	writeJSON(w, http.StatusOK, map[string]any{
		"ref": ref,
		"object": map[string]string{
			"sha":  body.SHA,
			"type": "commit",
		},
	})
}

func (s *Server) handleGetCommitBySHA(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rp := s.getRepo(r)
	if rp == nil {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	sha := r.PathValue("sha")
	c, ok := rp.Commits[sha]
	if !ok {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) handleGetPublicKey(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rp := s.getRepo(r)
	if rp == nil {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"key_id": s.keyID,
		"key":    s.pubKeyB64,
	})
}

func (s *Server) handlePutSecret(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rp := s.getRepo(r)
	if rp == nil {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	name := r.PathValue("name")
	var body struct {
		EncryptedValue string `json:"encrypted_value"`
		KeyID          string `json:"key_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	rp.Secrets[name] = body.EncryptedValue
	w.WriteHeader(http.StatusCreated)
}

func (s *Server) handleListWorkflowRuns(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rp := s.getRepo(r)
	if rp == nil {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	branch := r.URL.Query().Get("branch")
	// GitHub returns most-recent first; our slice keeps most-recent last, so reverse.
	var runs []workflowRun
	for i := len(rp.Runs) - 1; i >= 0; i-- {
		run := rp.Runs[i]
		if branch == "" || run.HeadBranch == branch {
			runs = append(runs, run)
		}
	}
	if runs == nil {
		runs = []workflowRun{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"total_count":   len(runs),
		"workflow_runs": runs,
	})
}

func (s *Server) handleListWorkflowJobs(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rp := s.getRepo(r)
	if rp == nil {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	runID, err := strconv.ParseInt(r.PathValue("run_id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid run id")
		return
	}

	for _, run := range rp.Runs {
		if run.ID == runID {
			jobs := run.Jobs
			if jobs == nil {
				jobs = []workflowJob{}
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"total_count": len(jobs),
				"jobs":        jobs,
			})
			return
		}
	}
	writeError(w, http.StatusNotFound, "Not Found")
}

// --- Admin API handlers ---

type seedRequest struct {
	Owner  string     `json:"owner"`
	Repo   string     `json:"repo"`
	Branch string     `json:"branch"`
	Topics []string   `json:"topics"`
	Files  []seedFile `json:"files"`
}

type seedFile struct {
	Path    string `json:"path"`
	Mode    string `json:"mode"`
	Content string `json:"content"`
}

func (s *Server) handleAdminSeed(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var req seedRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid seed request: "+err.Error())
		return
	}

	if req.Branch == "" {
		req.Branch = "main"
	}

	rp := &repo{
		Owner:         req.Owner,
		Name:          req.Repo,
		DefaultBranch: req.Branch,
		Topics:        req.Topics,
		Files:         make(map[string]string),
		Blobs:         make(map[string]string),
		Trees:         make(map[string][]treeEntry),
		Commits:       make(map[string]*commit),
		Refs:          make(map[string]string),
		Secrets:       make(map[string]string),
	}

	for _, f := range req.Files {
		rp.Files[f.Path] = f.Content
	}
	buildGitObjects(rp)

	key := req.Owner + "/" + req.Repo
	s.repos[key] = rp
	writeJSON(w, http.StatusOK, map[string]string{"status": "seeded", "repo": key})
}

func (s *Server) handleAdminReset(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.repos = make(map[string]*repo)
	writeJSON(w, http.StatusOK, map[string]string{"status": "reset"})
}

type adminRunRequest struct {
	Owner      string        `json:"owner"`
	Repo       string        `json:"repo"`
	Branch     string        `json:"branch"`
	HeadSHA    string        `json:"headSha"`
	Status     string        `json:"status"`
	Conclusion string        `json:"conclusion"`
	Jobs       []workflowJob `json:"jobs"`
}

func (s *Server) handleAdminSetRun(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var req adminRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid run request: "+err.Error())
		return
	}
	if req.Branch == "" {
		req.Branch = "main"
	}

	key := req.Owner + "/" + req.Repo
	rp, ok := s.repos[key]
	if !ok {
		writeError(w, http.StatusNotFound, "repo not seeded: "+key)
		return
	}

	s.runIDSeq++
	run := workflowRun{
		ID:         s.runIDSeq,
		HeadBranch: req.Branch,
		HeadSHA:    req.HeadSHA,
		Status:     req.Status,
		Conclusion: req.Conclusion,
		HTMLURL:    fmt.Sprintf("https://github.com/%s/actions/runs/%d", key, s.runIDSeq),
		Jobs:       req.Jobs,
	}
	// Replace the latest run for this branch, keep others.
	kept := rp.Runs[:0:0]
	for _, existing := range rp.Runs {
		if existing.HeadBranch != req.Branch {
			kept = append(kept, existing)
		}
	}
	rp.Runs = append(kept, run)

	writeJSON(w, http.StatusOK, map[string]any{"status": "run set", "id": run.ID})
}

// --- Helpers ---

func (s *Server) getRepo(r *http.Request) *repo {
	owner := r.PathValue("owner")
	name := r.PathValue("repo")
	return s.repos[owner+"/"+name]
}

func repoJSON(rp *repo) map[string]any {
	topics := rp.Topics
	if topics == nil {
		topics = []string{}
	}
	return map[string]any{
		"id":             hashInt(rp.Owner + "/" + rp.Name),
		"name":           rp.Name,
		"full_name":      rp.Owner + "/" + rp.Name,
		"html_url":       "https://github.com/" + rp.Owner + "/" + rp.Name,
		"default_branch": rp.DefaultBranch,
		"topics":         topics,
		"owner": map[string]string{
			"login": rp.Owner,
		},
	}
}

func matchesSearchQuery(q string, rp *repo) bool {
	// Parse simple search queries like "topic:serverless-function user:e2e-user".
	parts := strings.Fields(q)
	for _, part := range parts {
		if strings.HasPrefix(part, "topic:") {
			topic := strings.TrimPrefix(part, "topic:")
			if !slices.Contains(rp.Topics, topic) {
				return false
			}
		}
		if strings.HasPrefix(part, "user:") {
			user := strings.TrimPrefix(part, "user:")
			if rp.Owner != user {
				return false
			}
		}
	}
	return true
}

// resolveToTreeSHA resolves a ref (branch name, commit SHA, tree SHA, or HEAD) to a tree SHA.
// The go-github client passes the branch ref (e.g. "main"), "HEAD", or a commit SHA to GetTree.
func resolveToTreeSHA(rp *repo, ref string) string {
	// HEAD resolves to the default branch.
	if ref == "HEAD" {
		ref = rp.DefaultBranch
	}
	// Direct tree SHA match.
	if _, ok := rp.Trees[ref]; ok {
		return ref
	}
	// Commit SHA -> tree SHA.
	if c, ok := rp.Commits[ref]; ok {
		return c.Tree.SHA
	}
	// Branch name -> ref -> commit SHA -> tree SHA.
	if cSHA, ok := rp.Refs["refs/heads/"+ref]; ok {
		if c, ok := rp.Commits[cSHA]; ok {
			return c.Tree.SHA
		}
	}
	return ""
}

// buildGitObjects creates blobs, a tree, and a commit from the repo's Files,
// then sets the default branch ref to point at the new commit.
func buildGitObjects(rp *repo) {
	var entries []treeEntry
	for path, content := range rp.Files {
		sha := blobSHA(content)
		rp.Blobs[sha] = content
		entries = append(entries, treeEntry{
			Path: path,
			Mode: "100644",
			Type: "blob",
			SHA:  sha,
			Size: len(content),
		})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })

	tSHA := treeSHA(entries)
	rp.Trees[tSHA] = entries

	cSHA := commitSHA("Initial commit", tSHA, nil)
	c := &commit{SHA: cSHA, Message: "Initial commit"}
	c.Tree.SHA = tSHA
	rp.Commits[cSHA] = c

	rp.Refs["refs/heads/"+rp.DefaultBranch] = cSHA
}

func blobSHA(content string) string {
	h := sha256.Sum256([]byte("blob:" + content))
	return fmt.Sprintf("%x", h[:20])
}

func treeSHA(entries []treeEntry) string {
	var parts []string
	for _, e := range entries {
		parts = append(parts, e.Mode+" "+e.Path+" "+e.SHA)
	}
	h := sha256.Sum256([]byte("tree:" + strings.Join(parts, "\n")))
	return fmt.Sprintf("%x", h[:20])
}

func commitSHA(message, treeSHA string, parents []string) string {
	h := sha256.Sum256([]byte("commit:" + message + ":" + treeSHA + ":" + strings.Join(parents, ",")))
	return fmt.Sprintf("%x", h[:20])
}

func hashInt(s string) int {
	h := sha256.Sum256([]byte(s))
	return int(h[0])<<24 | int(h[1])<<16 | int(h[2])<<8 | int(h[3])
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("[fakegithub] failed to encode response: %v", err)
	}
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"message": msg})
}
