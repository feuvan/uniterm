package session

import (
	"fmt"
	"sync"
)

type SPICESession struct {
	baseSession
	proxyMu sync.RWMutex
	wsURL   string // direct WebSocket URL passed to frontend spice-client
}

func NewSPICESession(id string) *SPICESession {
	return &SPICESession{
		baseSession: baseSession{
			id:          id,
			sessionType: "spice",
			status:      StatusDisconnected,
		},
	}
}

func (s *SPICESession) Connect(config ConnectionConfig) error {
	s.setStatus(StatusConnecting)

	host := config.Host
	port := config.Port
	if port <= 0 {
		port = 5900
	} else if port < 100 {
		// libvirt display port format: :1 -> 5901, :23 -> 5923
		port = port + 5900
	}

	s.title = fmt.Sprintf("%s (SPICE)", config.Host)
	s.proxyMu.Lock()
	s.wsURL = fmt.Sprintf("ws://%s:%d/", host, port)
	s.proxyMu.Unlock()

	s.setStatus(StatusConnected)
	return nil
}

func (s *SPICESession) Disconnect() error {
	s.proxyMu.Lock()
	s.wsURL = ""
	s.proxyMu.Unlock()
	s.setStatus(StatusDisconnected)
	return nil
}

func (s *SPICESession) IsConnected() bool {
	return s.Status() == StatusConnected
}

func (s *SPICESession) Resize(cols, rows int) error {
	return nil
}

func (s *SPICESession) Write(data []byte) error {
	return nil
}

func (s *SPICESession) ProxyAddr() string {
	s.proxyMu.RLock()
	defer s.proxyMu.RUnlock()
	return s.wsURL
}
