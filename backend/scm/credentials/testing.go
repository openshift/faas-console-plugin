package credentials

import (
	"context"
	"errors"

	"github.com/openshift/faas-console-plugin/backend/identity"
)

// ProviderStub supplies credential operations for tests that exercise failures.
type ProviderStub struct {
	OnSave   func(context.Context, string, Credential) error
	OnGet    func(context.Context, string) (Credential, error)
	OnDelete func(context.Context, string) error
}

func (p ProviderStub) Save(ctx context.Context, ocpToken string, cred Credential) error {
	if p.OnSave != nil {
		return p.OnSave(ctx, ocpToken, cred)
	}
	return errors.New("save credential not implemented")
}

func (p ProviderStub) Get(ctx context.Context, ocpToken string) (Credential, error) {
	if p.OnGet != nil {
		return p.OnGet(ctx, ocpToken)
	}
	return Credential{}, errors.New("get credential not implemented")
}

func (p ProviderStub) Delete(ctx context.Context, ocpToken string) error {
	if p.OnDelete != nil {
		return p.OnDelete(ctx, ocpToken)
	}
	return errors.New("delete credential not implemented")
}

// MapProvider is a test fake keyed by caller token; identity binding is tested
// separately against Store, which resolves tokens to OpenShift users.
type MapProvider map[string]Credential

func (m MapProvider) Save(_ context.Context, ocpToken string, cred Credential) error {
	if ocpToken == "" {
		return identity.ErrUnauthenticated
	}
	m[ocpToken] = cred
	return nil
}

func (m MapProvider) Get(_ context.Context, ocpToken string) (Credential, error) {
	if ocpToken == "" {
		return Credential{}, identity.ErrUnauthenticated
	}
	if cred, ok := m[ocpToken]; ok {
		return cred, nil
	}
	return Credential{}, ErrNoCredential
}

func (m MapProvider) Delete(_ context.Context, ocpToken string) error {
	if ocpToken == "" {
		return identity.ErrUnauthenticated
	}
	delete(m, ocpToken)
	return nil
}
