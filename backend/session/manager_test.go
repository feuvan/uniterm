package session

import "testing"

func TestSessionManagerListIncludesDesktopProxyAddresses(t *testing.T) {
	manager := NewSessionManager()

	vnc := NewVNCSession("vnc-session")
	vnc.proxyMu.Lock()
	vnc.proxyAddr = "ws://127.0.0.1:5901/"
	vnc.proxyMu.Unlock()
	spice := NewSPICESession("spice-session")
	spice.proxyMu.Lock()
	spice.wsURL = "ws://127.0.0.1:5902/"
	spice.proxyMu.Unlock()
	ssh := NewSSHSession("ssh-session")

	manager.Add(vnc)
	manager.Add(spice)
	manager.Add(ssh)

	byID := make(map[string]SessionInfo)
	for _, info := range manager.List() {
		byID[info.ID] = info
	}

	if got := byID[vnc.ID()].ProxyAddr; got != "ws://127.0.0.1:5901/" {
		t.Fatalf("VNC proxy address = %q", got)
	}
	if got := byID[spice.ID()].ProxyAddr; got != "ws://127.0.0.1:5902/" {
		t.Fatalf("SPICE proxy address = %q", got)
	}
	if got := byID[ssh.ID()].ProxyAddr; got != "" {
		t.Fatalf("SSH proxy address = %q, want empty", got)
	}
}

func TestDesktopSessionDisconnectClearsProxyAddress(t *testing.T) {
	vnc := NewVNCSession("vnc-session")
	vnc.proxyMu.Lock()
	vnc.proxyAddr = "ws://127.0.0.1:5901/"
	vnc.proxyMu.Unlock()
	if err := vnc.Disconnect(); err != nil {
		t.Fatalf("Disconnect() error = %v", err)
	}
	if got := vnc.ProxyAddr(); got != "" {
		t.Fatalf("VNC proxy address after disconnect = %q, want empty", got)
	}

	spice := NewSPICESession("spice-session")
	spice.proxyMu.Lock()
	spice.wsURL = "ws://127.0.0.1:5902/"
	spice.proxyMu.Unlock()
	if err := spice.Disconnect(); err != nil {
		t.Fatalf("Disconnect() error = %v", err)
	}
	if got := spice.ProxyAddr(); got != "" {
		t.Fatalf("SPICE proxy address after disconnect = %q, want empty", got)
	}
}
