import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var controller: AgenticWalletController

    var body: some View {
        NavigationStack {
            Form {
                Section("Wallet") {
                    Picker("Wallet", selection: $controller.selectedWalletID) {
                        ForEach(controller.walletOptions) { wallet in
                            Text(wallet.name).tag(wallet.id)
                        }
                    }
                    Picker("Cluster", selection: $controller.selectedCluster) {
                        ForEach(AgenticCluster.allCases) { cluster in
                            Text(cluster.rawValue).tag(cluster)
                        }
                    }
                    LabeledContent("Transport", value: transportLabel(controller.selectedWallet.transport))
                    LabeledContent("Cache", value: "\(controller.cacheCount)")
                }

                Section("Session") {
                    if let record = controller.currentRecord {
                        LabeledContent("Wallet", value: record.walletName)
                        LabeledContent("Address", value: short(record.publicKey))
                        LabeledContent("Status", value: record.authenticated ? "Authenticated" : "Disconnected")
                    } else {
                        LabeledContent("Status", value: controller.status)
                    }
                    if let pending = controller.pendingRequest {
                        LabeledContent("Pending", value: "\(pending.phase.rawValue) \(short(pending.id))")
                    }
                    if let lastSignature = controller.lastSignature {
                        LabeledContent("Signature", value: short(lastSignature))
                    }
                    if let lastError = controller.lastError {
                        Text(lastError)
                            .foregroundStyle(.red)
                    }
                }

                Section("Actions") {
                    Button("Connect") {
                        controller.connect()
                    }
                    Button("Sign Demo Message") {
                        controller.signDemoMessage()
                    }
                    Button("Reconnect Cached") {
                        controller.reconnectCached()
                    }
                    Button("Disconnect") {
                        controller.disconnect()
                    }
                }

                Section("State") {
                    Button("Clear Transient State") {
                        controller.clearTransientState()
                    }
                    Button("Clear State Full Reset") {
                        controller.clearStateFullReset()
                    }
                    Button("Clear All Cached Authorizations", role: .destructive) {
                        controller.clearAllCachedAuthorizations()
                    }
                }
            }
            .navigationTitle("Agentic")
        }
    }

    private func transportLabel(_ transport: AgenticWalletTransport) -> String {
        switch transport {
        case .encryptedDeeplink:
            "Encrypted Deeplink"
        case .walletConnect:
            "WalletConnect"
        }
    }

    private func short(_ value: String, prefix: Int = 8, suffix: Int = 8) -> String {
        if value.count <= prefix + suffix {
            return value
        }
        return "\(value.prefix(prefix))...\(value.suffix(suffix))"
    }
}
