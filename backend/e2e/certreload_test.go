//go:build e2e

package e2e

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/portforward"
	"k8s.io/client-go/transport/spdy"
)

// rotationTimeout allows for kubelet propagating the recreated Secret to the
// mounted volume (up to ~90s) plus the reloader's own detection.
const rotationTimeout = 5 * time.Minute

const pollInterval = 5 * time.Second

const certProbeTimeout = 5 * time.Second

var _ = Describe("TLS certificate reload", Ordered, func() {
	var (
		ctx       context.Context
		config    *rest.Config
		clientset *kubernetes.Clientset
		namespace string
		secret    string
		httpsPort int
		pod       corev1.Pod
		forward   *portForward
	)

	BeforeAll(func() {
		namespace = os.Getenv("E2E_NAMESPACE")
		if namespace == "" {
			Skip("E2E_NAMESPACE is not set")
		}
		plugin := envOrDefault("E2E_PLUGIN_NAME", "console-functions-plugin")
		secret = envOrDefault("E2E_CERT_SECRET", plugin+"-cert")
		selector := envOrDefault("E2E_POD_SELECTOR", "app.kubernetes.io/name="+plugin)
		httpsPort = envIntOrDefault("E2E_HTTPS_PORT", 9443)

		ctx = context.Background()

		var err error
		config, err = clientConfig()
		Expect(err).NotTo(HaveOccurred())
		clientset, err = kubernetes.NewForConfig(config)
		Expect(err).NotTo(HaveOccurred())

		pod = runningPod(ctx, clientset, namespace, selector)

		forward, err = newPortForward(ctx, config, clientset, namespace, pod.Name, httpsPort)
		Expect(err).NotTo(HaveOccurred())
		DeferCleanup(forward.Close)
	})

	It("serves a rotated certificate without restarting the pod", func() {
		var before, after string

		By("recording the currently served certificate", func() {
			var err error
			before, err = servedCertSerial(ctx, forward.LocalPort)
			Expect(err).NotTo(HaveOccurred())
			Expect(before).NotTo(BeEmpty())
		})

		By("forcing a rotation by deleting the serving-cert secret", func() {
			err := clientset.CoreV1().Secrets(namespace).Delete(ctx, secret, metav1.DeleteOptions{})
			Expect(err).NotTo(HaveOccurred())
		})

		By("observing the served certificate change", func() {
			after = waitForRotatedCert(ctx, forward.LocalPort, before)
		})

		By("confirming the pod was not restarted", func() {
			current := getPod(ctx, clientset, namespace, pod.Name)
			Expect(current.UID).To(Equal(pod.UID), "pod was recreated")
			Expect(restartCount(current)).To(Equal(restartCount(pod)), "container restarted")
		})

		Expect(after).NotTo(Equal(before))
	})
})

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envIntOrDefault(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	var n int
	_, err := fmt.Sscanf(v, "%d", &n)
	Expect(err).NotTo(HaveOccurred(), "invalid %s", key)
	return n
}

func clientConfig() (*rest.Config, error) {
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	overrides := &clientcmd.ConfigOverrides{}
	return clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, overrides).ClientConfig()
}

func runningPod(ctx context.Context, cs *kubernetes.Clientset, ns, selector string) corev1.Pod {
	pods, err := cs.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{LabelSelector: selector})
	Expect(err).NotTo(HaveOccurred())
	for _, p := range pods.Items {
		if p.Status.Phase == corev1.PodRunning {
			return p
		}
	}
	Fail(fmt.Sprintf("no running pod for selector %q in namespace %q", selector, ns))
	return corev1.Pod{}
}

func getPod(ctx context.Context, cs *kubernetes.Clientset, ns, name string) corev1.Pod {
	p, err := cs.CoreV1().Pods(ns).Get(ctx, name, metav1.GetOptions{})
	Expect(err).NotTo(HaveOccurred())
	return *p
}

func restartCount(pod corev1.Pod) int32 {
	var total int32
	for _, cs := range pod.Status.ContainerStatuses {
		total += cs.RestartCount
	}
	return total
}

// servedCertSerial completes a TLS handshake through the port-forward and
// returns the serial number of the leaf certificate the process is serving now.
func servedCertSerial(ctx context.Context, localPort uint16) (string, error) {
	probeCtx, cancel := context.WithTimeout(ctx, certProbeTimeout)
	defer cancel()
	dialer := &tls.Dialer{Config: &tls.Config{InsecureSkipVerify: true}}
	conn, err := dialer.DialContext(probeCtx, "tcp", fmt.Sprintf("127.0.0.1:%d", localPort))
	if err != nil {
		return "", fmt.Errorf("probe served certificate: %w", err)
	}
	defer conn.Close()

	state := conn.(*tls.Conn).ConnectionState()
	if len(state.PeerCertificates) == 0 {
		return "", fmt.Errorf("TLS peer did not present a certificate")
	}
	return state.PeerCertificates[0].SerialNumber.String(), nil
}

func waitForRotatedCert(ctx context.Context, localPort uint16, before string) string {
	rotationCtx, cancel := context.WithTimeout(ctx, rotationTimeout)
	defer cancel()
	var observed string
	Eventually(rotationCtx, func() (string, error) {
		serial, err := servedCertSerial(rotationCtx, localPort)
		if err == nil {
			observed = serial
		}
		return serial, err
	}, rotationTimeout, pollInterval).Should(And(Not(BeEmpty()), Not(Equal(before))))
	return observed
}

type portForward struct {
	LocalPort uint16
	stop      chan struct{}
}

func (p *portForward) Close() {
	close(p.stop)
}

func newPortForward(ctx context.Context, config *rest.Config, cs *kubernetes.Clientset, ns, pod string, remotePort int) (*portForward, error) {
	transport, upgrader, err := spdy.RoundTripperFor(config)
	if err != nil {
		return nil, err
	}
	req := cs.CoreV1().RESTClient().Post().
		Resource("pods").Namespace(ns).Name(pod).SubResource("portforward")
	dialer := spdy.NewDialer(upgrader, &http.Client{Transport: transport}, http.MethodPost, req.URL())

	stop := make(chan struct{})
	ready := make(chan struct{})
	pf, err := portforward.New(dialer, []string{fmt.Sprintf("0:%d", remotePort)}, stop, ready, io.Discard, io.Discard)
	if err != nil {
		return nil, err
	}

	errCh := make(chan error, 1)
	go func() { errCh <- pf.ForwardPorts() }()

	select {
	case <-ready:
	case err := <-errCh:
		return nil, fmt.Errorf("port-forward failed: %w", err)
	case <-time.After(30 * time.Second):
		close(stop)
		return nil, fmt.Errorf("port-forward did not become ready")
	}

	ports, err := pf.GetPorts()
	if err != nil {
		close(stop)
		return nil, err
	}
	return &portForward{LocalPort: ports[0].Local, stop: stop}, nil
}
