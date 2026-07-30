package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"knative.dev/func/pkg/functions"
)

func TestEnvVarToFuncEnv(t *testing.T) {
	tests := []struct {
		name     string
		input    envVarEntry
		wantName string
		wantVal  string
	}{
		{
			name:     "plain value",
			input:    envVarEntry{Name: "API_URL", Source: "value", Value: "https://api.example.com"},
			wantName: "API_URL",
			wantVal:  "https://api.example.com",
		},
		{
			name:     "secret reference",
			input:    envVarEntry{Name: "DB_PASS", Source: "secret", ResourceName: "db-creds", ResourceKey: "password"},
			wantName: "DB_PASS",
			wantVal:  "{{ secret:db-creds:password }}",
		},
		{
			name:     "configMap reference",
			input:    envVarEntry{Name: "LOG_LEVEL", Source: "configMap", ResourceName: "app-config", ResourceKey: "log-level"},
			wantName: "LOG_LEVEL",
			wantVal:  "{{ configMap:app-config:log-level }}",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			env := envVarToFuncEnv(tc.input)
			if *env.Name != tc.wantName {
				t.Errorf("name = %q, want %q", *env.Name, tc.wantName)
			}
			if *env.Value != tc.wantVal {
				t.Errorf("value = %q, want %q", *env.Value, tc.wantVal)
			}
		})
	}
}

func TestInjectEnvVars(t *testing.T) {
	root := t.TempDir()

	client := functions.New()
	_, err := client.Init(functions.Function{
		Name:      "test-func",
		Root:      root,
		Runtime:   "node",
		Registry:  "example.com/test",
		Namespace: "default",
		Template:  "http",
	})
	if err != nil {
		t.Fatalf("failed to init function: %v", err)
	}

	envs := []envVarEntry{
		{Name: "API_URL", Source: "value", Value: "https://api.example.com"},
		{Name: "DB_PASS", Source: "secret", ResourceName: "db-creds", ResourceKey: "password"},
		{Name: "LOG_LEVEL", Source: "configMap", ResourceName: "app-config", ResourceKey: "log-level"},
	}

	if err := injectEnvVars(root, envs); err != nil {
		t.Fatalf("injectEnvVars failed: %v", err)
	}

	content, err := os.ReadFile(filepath.Join(root, "func.yaml"))
	if err != nil {
		t.Fatalf("failed to read func.yaml: %v", err)
	}
	yaml := string(content)

	checks := []string{
		"name: API_URL",
		"value: https://api.example.com",
		"name: DB_PASS",
		"'{{ secret:db-creds:password }}'",
		"name: LOG_LEVEL",
		"'{{ configMap:app-config:log-level }}'",
	}
	for _, check := range checks {
		if !strings.Contains(yaml, check) {
			t.Errorf("func.yaml missing %q.\nContent:\n%s", check, yaml)
		}
	}
}
