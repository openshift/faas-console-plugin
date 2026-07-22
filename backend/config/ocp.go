package config

// OCPInternalRegistry is the URL prefix for the OpenShift in-cluster image registry.
// CI workflows targeting this registry skip external login since the runner
// authenticates via the kubeconfig's service account token.
const OCPInternalRegistry = "image-registry.openshift-image-registry.svc:5000/"
