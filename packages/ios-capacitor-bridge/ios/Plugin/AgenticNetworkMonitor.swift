// Singleton wrapper around NWPathMonitor — cached network status for
// AgenticSystemPlugin.systemInfo(). One monitor instance for the whole bridge
// (NWPathMonitor is expensive to spin up per-call).
import Foundation
import Network

final class AgenticNetworkMonitor {
    static let shared = AgenticNetworkMonitor()

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.agentic.wallet.network", qos: .utility)
    private var lastSnapshot: String = "unknown"
    private var hasObservedFirst = false

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            self.lastSnapshot = self.classify(path)
            self.hasObservedFirst = true
        }
        monitor.start(queue: queue)
    }

    /// Current network type as a stable string. Returns "unknown" until the
    /// first path update fires (usually <100ms after init).
    var current: String {
        // Reading lastSnapshot from any thread is safe — Swift `String` write
        // is atomic on stored properties of class types in practice. If we
        // ever care, switch to OSAllocatedUnfairLock.
        lastSnapshot
    }

    var hasObserved: Bool { hasObservedFirst }

    private func classify(_ path: NWPath) -> String {
        guard path.status == .satisfied else { return "offline" }
        if path.usesInterfaceType(.wifi) { return "wifi" }
        if path.usesInterfaceType(.cellular) { return "cellular" }
        if path.usesInterfaceType(.wiredEthernet) { return "wired" }
        if path.usesInterfaceType(.loopback) { return "loopback" }
        return "other"
    }
}
