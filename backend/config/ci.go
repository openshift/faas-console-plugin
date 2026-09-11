package config

import "os"

const FuncCLIVersionDefault = "knative-v1.23.3"

// FuncCLIVersion is the knative func CLI version installed by generated CI workflows.
// Override with FUNC_CLI_VERSION env var. Update the default when bumping knative.dev/func.
var FuncCLIVersion = func() string {
	if v := os.Getenv("FUNC_CLI_VERSION"); v != "" {
		return v
	}
	return FuncCLIVersionDefault
}()
