package handler

import (
	"errors"
	"log/slog"
	"net/http"

	"go.yaml.in/yaml/v3"
	"golang.org/x/sync/errgroup"

	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/scm"
)

type listItem struct {
	Owner         string `json:"owner"`
	RepoName      string `json:"repoName"`
	URL           string `json:"url"`
	DefaultBranch string `json:"defaultBranch"`
	Name          string `json:"name"`
	Namespace     string `json:"namespace"`
	Runtime       string `json:"runtime"`
}

type funcYamlFields struct {
	Name      string `yaml:"name"`
	Namespace string `yaml:"namespace"`
	Runtime   string `yaml:"runtime"`
}

func parseFuncYaml(content string) (name, namespace, runtime string) {
	var f funcYamlFields
	if err := yaml.Unmarshal([]byte(content), &f); err != nil {
		return "", "", ""
	}
	return f.Name, f.Namespace, f.Runtime
}

func (h *Handlers) HandleListFunctions(w http.ResponseWriter, r *http.Request) {
	pat, ok := extractSCMToken(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "X-SCM-Token header is required")
		return
	}

	client := config.SCMRegistry.Client(scm.DefaultPlatform, pat)

	repos, err := client.ListRepos(r.Context())
	if err != nil {
		if errors.Is(err, scm.ErrUnauthorized) {
			writeError(w, http.StatusUnauthorized, "invalid SCM token")
			return
		}
		slog.Error("failed to list repos", "err", err)
		writeError(w, http.StatusBadGateway, "failed to list repositories")
		return
	}

	items := make([]listItem, len(repos))
	for i, repo := range repos {
		items[i] = listItem{
			Owner:         repo.Owner,
			RepoName:      repo.Name,
			URL:           repo.URL,
			DefaultBranch: repo.DefaultBranch,
		}
	}

	g, ctx := errgroup.WithContext(r.Context())
	g.SetLimit(10)
	for i, repo := range repos {
		g.Go(func() error {
			content, err := client.GetFileContent(ctx, repo.Owner, repo.Name, repo.DefaultBranch, "func.yaml")
			if err != nil {
				slog.Warn("failed to read func.yaml", "repo", repo.Owner+"/"+repo.Name, "err", err)
				return nil
			}
			items[i].Name, items[i].Namespace, items[i].Runtime = parseFuncYaml(content)
			return nil
		})
	}
	_ = g.Wait()

	writeJSON(w, http.StatusOK, items)
}
