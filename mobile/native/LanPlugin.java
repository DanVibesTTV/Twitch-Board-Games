package com.danvibes.streamboardgames;

// Same-WiFi multiplayer for Stream Board Games (used by net/transport.js, "native").
//
// Host:   a TCP server (port 47823, or a free one) announced via Android network service
//         discovery as "_sbgames._tcp". Events: peer {peerId}, peerMessage {peerId, data},
//         peerLeft {peerId}.
// Join:   discover() lists hosts (found {name, address} / lost {name}); connect({host, port}).
//         Events: message {data}, closed {reason}.
// Messages are text, one per line (the JS side sends JSON, which never contains a raw newline).
// Every connection has its own writer thread, so messages arrive in the order they were sent.
//
// Copied into the generated Android project and registered in MainActivity by
// mobile/prepare-android.mjs.

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Map;
import java.util.Queue;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "Lan")
public class LanPlugin extends Plugin {

    private static final String SERVICE_TYPE = "_sbgames._tcp.";
    private static final int DEFAULT_PORT = 47823;

    private final ExecutorService io = Executors.newCachedThreadPool();
    private final Map<String, Conn> peers = new ConcurrentHashMap<>();
    private volatile ServerSocket server;
    private volatile Conn hostConn; // this phone joined someone else's game

    private NsdManager nsd;
    private NsdManager.RegistrationListener registration;
    private NsdManager.DiscoveryListener discovery;
    private WifiManager.MulticastLock multicastLock;
    private final Queue<NsdServiceInfo> resolveQueue = new ConcurrentLinkedQueue<>();
    private boolean resolving = false;

    // One TCP connection with an ordered writer.
    private static class Conn {
        final String id;
        final Socket socket;
        final BufferedWriter out;
        final ExecutorService writer = Executors.newSingleThreadExecutor();

        Conn(String id, Socket socket) throws IOException {
            this.id = id;
            this.socket = socket;
            this.out = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8));
        }

        void post(String line, PluginCall call) {
            writer.execute(() -> {
                try {
                    out.write(line);
                    out.write('\n');
                    out.flush();
                    if (call != null) call.resolve();
                } catch (IOException e) {
                    close();
                    if (call != null) call.reject("Send failed: " + e.getMessage());
                }
            });
        }

        void close() {
            try {
                socket.close();
            } catch (IOException ignored) {
            }
            writer.shutdown();
        }
    }

    @Override
    public void load() {
        nsd = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
    }

    // ── hosting ──

    @PluginMethod
    public void startHost(PluginCall call) {
        final int port = call.getInt("port", DEFAULT_PORT);
        final String name = call.getString("name", "Board Games");
        io.execute(() -> {
            try {
                stopHostInternal();
                ServerSocket s;
                try {
                    s = new ServerSocket(port);
                } catch (IOException busy) {
                    s = new ServerSocket(0); // the usual port is taken: any free one
                }
                server = s;
                final ServerSocket listening = s;
                io.execute(() -> acceptLoop(listening));
                register(name, s.getLocalPort());
                JSObject ret = new JSObject();
                ret.put("port", s.getLocalPort());
                ret.put("addresses", addresses());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Could not start hosting: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void stopHost(PluginCall call) {
        io.execute(() -> {
            stopHostInternal();
            call.resolve();
        });
    }

    @PluginMethod
    public void sendTo(PluginCall call) {
        String id = call.getString("peerId");
        Conn c = id == null ? null : peers.get(id);
        if (c == null) {
            call.reject("Unknown player");
            return;
        }
        c.post(call.getString("data", ""), call);
    }

    private void acceptLoop(ServerSocket s) {
        while (!s.isClosed()) {
            try {
                Socket socket = s.accept();
                socket.setTcpNoDelay(true);
                Conn c = new Conn(UUID.randomUUID().toString(), socket);
                peers.put(c.id, c);
                JSObject ev = new JSObject();
                ev.put("peerId", c.id);
                notifyListeners("peer", ev);
                io.execute(() -> readLoop(c, true));
            } catch (IOException e) {
                break; // server closed
            }
        }
    }

    private void stopHostInternal() {
        unregister();
        ServerSocket s = server;
        server = null;
        if (s != null) {
            try {
                s.close();
            } catch (IOException ignored) {
            }
        }
        for (Conn c : peers.values()) c.close();
        peers.clear();
    }

    private void register(String name, int port) {
        unregister();
        if (nsd == null) return;
        NsdServiceInfo info = new NsdServiceInfo();
        info.setServiceName(name);
        info.setServiceType(SERVICE_TYPE);
        info.setPort(port);
        registration = new NsdManager.RegistrationListener() {
            @Override
            public void onServiceRegistered(NsdServiceInfo i) {}

            @Override
            public void onRegistrationFailed(NsdServiceInfo i, int code) {}

            @Override
            public void onServiceUnregistered(NsdServiceInfo i) {}

            @Override
            public void onUnregistrationFailed(NsdServiceInfo i, int code) {}
        };
        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, registration);
    }

    private void unregister() {
        if (registration != null && nsd != null) {
            try {
                nsd.unregisterService(registration);
            } catch (Exception ignored) {
            }
        }
        registration = null;
    }

    // IPv4 addresses of this phone on the local network (shown so others can type one in).
    private JSArray addresses() {
        JSArray list = new JSArray();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) list.put(a.getHostAddress());
                }
            }
        } catch (Exception ignored) {
        }
        return list;
    }

    // ── finding games ──

    @PluginMethod
    public void discover(PluginCall call) {
        stopDiscoveryInternal();
        if (nsd == null) {
            call.reject("Network service discovery is not available");
            return;
        }
        acquireMulticastLock();
        discovery = new NsdManager.DiscoveryListener() {
            @Override
            public void onStartDiscoveryFailed(String type, int code) {}

            @Override
            public void onStopDiscoveryFailed(String type, int code) {}

            @Override
            public void onDiscoveryStarted(String type) {}

            @Override
            public void onDiscoveryStopped(String type) {}

            @Override
            public void onServiceFound(NsdServiceInfo info) {
                queueResolve(info);
            }

            @Override
            public void onServiceLost(NsdServiceInfo info) {
                JSObject ev = new JSObject();
                ev.put("name", info.getServiceName());
                notifyListeners("lost", ev);
            }
        };
        nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discovery);
        call.resolve();
    }

    @PluginMethod
    public void stopDiscovery(PluginCall call) {
        stopDiscoveryInternal();
        call.resolve();
    }

    private void stopDiscoveryInternal() {
        if (discovery != null && nsd != null) {
            try {
                nsd.stopServiceDiscovery(discovery);
            } catch (Exception ignored) {
            }
        }
        discovery = null;
        resolveQueue.clear();
        releaseMulticastLock();
    }

    // Older Android versions resolve one service at a time.
    private synchronized void queueResolve(NsdServiceInfo info) {
        resolveQueue.add(info);
        if (!resolving) resolveNext();
    }

    @SuppressWarnings("deprecation")
    private synchronized void resolveNext() {
        NsdServiceInfo next = resolveQueue.poll();
        if (next == null) {
            resolving = false;
            return;
        }
        resolving = true;
        nsd.resolveService(next, new NsdManager.ResolveListener() {
            @Override
            public void onResolveFailed(NsdServiceInfo i, int code) {
                resolveNext();
            }

            @Override
            public void onServiceResolved(NsdServiceInfo i) {
                InetAddress host = i.getHost();
                if (host != null) {
                    String ip = host.getHostAddress();
                    if (ip != null && ip.contains(":")) ip = "[" + ip + "]"; // IPv6
                    JSObject ev = new JSObject();
                    ev.put("name", i.getServiceName());
                    ev.put("address", ip + ":" + i.getPort());
                    notifyListeners("found", ev);
                }
                resolveNext();
            }
        });
    }

    private void acquireMulticastLock() {
        try {
            WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi != null && multicastLock == null) {
                multicastLock = wifi.createMulticastLock("stream-board-games");
                multicastLock.setReferenceCounted(false);
                multicastLock.acquire();
            }
        } catch (Exception ignored) {
        }
    }

    private void releaseMulticastLock() {
        if (multicastLock != null) {
            try {
                multicastLock.release();
            } catch (Exception ignored) {
            }
        }
        multicastLock = null;
    }

    // ── joining ──

    @PluginMethod
    public void connect(PluginCall call) {
        final String host = call.getString("host");
        final int port = call.getInt("port", DEFAULT_PORT);
        if (host == null || host.isEmpty()) {
            call.reject("No address");
            return;
        }
        io.execute(() -> {
            try {
                disconnectInternal();
                Socket s = new Socket();
                s.connect(new InetSocketAddress(host, port), 5000);
                s.setTcpNoDelay(true);
                Conn c = new Conn("host", s);
                hostConn = c;
                io.execute(() -> readLoop(c, false));
                call.resolve();
            } catch (Exception e) {
                call.reject("No game found at " + host + " (" + e.getMessage() + ")");
            }
        });
    }

    @PluginMethod
    public void send(PluginCall call) {
        Conn c = hostConn;
        if (c == null) {
            call.reject("Not connected");
            return;
        }
        c.post(call.getString("data", ""), call);
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        io.execute(() -> {
            disconnectInternal();
            call.resolve();
        });
    }

    private void disconnectInternal() {
        Conn c = hostConn;
        hostConn = null; // set first: an intentional disconnect sends no "closed" event
        if (c != null) c.close();
    }

    // ── reading (both sides) ──

    private void readLoop(Conn c, boolean asHost) {
        try (BufferedReader in = new BufferedReader(new InputStreamReader(c.socket.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = in.readLine()) != null) {
                JSObject ev = new JSObject();
                ev.put("data", line);
                if (asHost) {
                    ev.put("peerId", c.id);
                    notifyListeners("peerMessage", ev);
                } else {
                    notifyListeners("message", ev);
                }
            }
        } catch (IOException ignored) {
        } finally {
            c.close();
            if (asHost) {
                if (peers.remove(c.id) != null) {
                    JSObject ev = new JSObject();
                    ev.put("peerId", c.id);
                    notifyListeners("peerLeft", ev);
                }
            } else if (hostConn == c) {
                hostConn = null;
                JSObject ev = new JSObject();
                ev.put("reason", "The connection to the host was lost.");
                notifyListeners("closed", ev);
            }
        }
    }

    @Override
    protected void handleOnDestroy() {
        stopDiscoveryInternal();
        stopHostInternal();
        disconnectInternal();
        io.shutdownNow();
    }
}
