package credentials

import "context"

// Provider stores and retrieves SCM credentials for an OpenShift caller.
type Provider interface {
	Save(ctx context.Context, ocpToken string, cred Credential) error
	Get(ctx context.Context, ocpToken string) (Credential, error)
	Delete(ctx context.Context, ocpToken string) error
}
