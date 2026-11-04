# SRVOCF-1110: Store SCM credentials on the backend

Status: Implemented
Date: 2026-11-04
Jira: SRVOCF-1110

## Problem

The GitHub PAT used to live in the browser's sessionStorage and travel with
every request in an `X-SCM-Token` header. Any script running in the console
could read it, and every new tab had to ask for it again. This design moves the
PAT to the backend: the browser hands it over once, and from then on the
backend finds it by the caller's OpenShift identity.

## Storage: one Secret per OpenShift user

A user's SCM credential lives in one Secret named after a SHA-256 of their identity (the UID where they have one, the username otherwise, prefixed so the two cannot collide). The name is hashed because it is not a secret: it shows up in audit logs and in `oc get secrets` for anyone with read access to the namespace. Connecting again overwrites that Secret rather than adding another, so a user never accumulates live PATs nobody deletes, and revocation has exactly one thing to delete.

`credentials.Store` takes the console's bearer token and resolves it itself, so a caller cannot reach a credential without having proved whose it is. The binding written into the Secret is verified on every read rather than inferred from where the Secret was found, since a deleted and recreated account could hash to the same name. HTTP handlers depend on `credentials.Provider`, implemented by `Store`, and tests inject a local `MapProvider` or `ProviderStub`; identity binding and expiry remain covered by the store tests over `k8s.io/client-go/kubernetes/fake`.

## Identity

The identity comes from the console proxy, which is declared `authorization: UserToken` and forwards the console user's bearer token in `Authorization`. That token is opaque, so `identity.Resolver` asks the API server who it belongs to with a `SelfSubjectReview` (the call behind `oc auth whoami`), which every authenticated user may create; reading `users.user.openshift.io` would need a `ClusterRole` the backend does not have. Every credential save, read, and delete repeats this check, so a token rejected by the API server cannot continue reaching stored SCM credentials through a cached identity. The Secret is accessed with the backend's own ServiceAccount, which cannot establish whether the caller's console token is still valid on its own.

`identity.User` carries both the username and the UID. The UID is the authoritative key where it exists, since a username can be deleted and recreated for a different person while a UID is never reused, but `kube:admin` is backed by a static Secret rather than a `User` object and has none, so `Matches` compares both and falls back to the name alone when neither side has a UID. Two empty users never match, which keeps a credential written without a binding from being readable by everybody.

## No second token

An earlier design issued a plugin session token alongside the credential. It was removed because it never was a second secret: the endpoint that re-issued it authenticated with the OpenShift token alone, so reaching the console proxy as a given user already yielded their SCM-backed session. What the token did buy was cost: a second TTL, a reissue path, a browser handle to lose, and a 401-resume-retry loop to recover it. Dropping it leaves the property that actually mattered intact, because it never came from the token: the credential is bound to an OpenShift identity, a caller who is somebody else cannot read it, and the PAT is never in the browser.

The consequence worth stating plainly is unchanged. Anyone who can reach the console proxy as a given OpenShift user can act with that user's stored SCM credential. That is the same exposure the console itself has, and it is the price of not making the user paste their PAT into every new tab.

## Request path

Two middlewares in `backend/handler/middleware.go` split the two questions a request can fail on. `RequireOCPToken` asks "is the caller authenticated?": `newMux` (`backend/main.go`) mounts it over the whole `/api/v1/` sub-mux, where it rejects a missing or malformed bearer header with 401 and puts the caller's OpenShift token into request context for `ocpTokenFrom`. `RequireSCMCredential` asks "has the caller connected to GitHub?" and wraps only the function routes, which cannot work without a stored credential: it resolves the credential once and puts it, together with the token, into context as a `requestCredential` for `credentialFrom`. A missing credential there is 401, a rejected caller token is 401, and a store failure is 503. The credential routes sit behind `RequireOCPToken` alone, because connecting and disconnecting must work for a caller with nothing stored, and the GET does its own lookup so it can answer 404 when nothing is stored, without the middleware knowing about specific routes. Health, static files, and workflow SSE stay outside both: the SSE handler frames its failures inside the stream, so it checks the caller itself. `LoggingMiddleware` lives in the same file and wraps the whole mux.

`WorkflowRunWatch` remains a standalone handler constructor with its own watch options. `WithCredentialsProvider` injects its read-only `handler.CredentialProvider` interface, which both `credentials.Store` and the test providers implement. It opens the SSE response before resolving the caller's credential, so missing or rejected caller credentials produce a 401 `app-error` frame and store failures produce a 503 frame, all within HTTP 200 responses.

## The credential resource

The caller's SCM credential is one resource with three verbs, named for what it is rather than for the token inside it: `GET` answers with the account the credential belongs to, which is its only representation that is safe to return. The provider sits in the path so a second one can be added beside it; it is the literal `github` until there is a second, rather than a parameter the backend would accept and ignore.

- `POST /api/v1/scm/github/credential` verifies the PAT with the SCM provider **before** writing it, so a token that cannot work never overwrites one that still does. It answers 201 with the SCM login and avatar, never the token, and **403** when the provider rejects what was supplied.
- `GET /api/v1/scm/github/credential` answers 200 with the connected account, or **404** when the user has nothing stored. Not 401: the frontend reads 404 as "ask for a PAT" and 401 as an authentication failure, and conflating them would prompt on a backend blip. A 503 says the store could not be read, which is not the same as there being nothing in it.
- `DELETE /api/v1/scm/github/credential` is keyed on the OpenShift user. A leaked anything must not be a way to revoke somebody else's connection, and the browser disconnects regardless of whether the call succeeds. The backend Role needs `update` on secrets alongside `create`, `get`, and `delete`, because reconnecting overwrites the Secret in place.

## A 401 that means one thing

`writeAuthError` is the only source of 401, which is what lets the frontend read that one status as "connect to GitHub": either the OpenShift identity could not be established, or the store holds no credential for it. That has to hold everywhere, because `customFetch` turns any 401 into `AUTH_EXPIRED_EVENT` and disconnects. An SCM provider rejecting a token is a **403**, whether the token was stored earlier or supplied on the request being served: re-asking for the OpenShift identity cannot repair either, and answering 401 for a mistyped PAT would throw away a working connection.

The frontend holds no auth state of its own. `AuthProvider` calls `GET /api/v1/scm/github/credential` on mount, and renders a spinner rather than its children until the answer arrives, so a user whose PAT is already stored is connected having typed nothing and nothing below ever has to reason about "not connected yet". `customFetch` does not retry: a 401 fires `AUTH_EXPIRED_EVENT` and `AuthProvider` clears its state. That is why a rejected PAT is a 403 and not a 401, which would disconnect a user over a typo.

## Expiry

A stored credential expires when its token does: `POST` records the expiry GitHub reports in the `GitHub-Authentication-Token-Expiration` header, so the user is not asked to reconnect while the token still works. Tokens created without an expiry have no header and fall back to `credentialTTL` (30d). Either way the expiry is absolute and not sliding. Credentials past it are dropped when their owner next comes back (`dropSecretIfExpired`). There is no background sweep and writes are last-write-wins, so a credential whose owner never returns stays until its Secret is removed by other means, and concurrent writes to one user's Secret resolve by whoever lands last. Both are deliberate for a tech preview.
