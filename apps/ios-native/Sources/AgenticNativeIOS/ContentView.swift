import SwiftUI
#if canImport(UIKit)
import UIKit
#endif
#if canImport(AppKit)
import AppKit
#endif

struct ContentView: View {
    @EnvironmentObject private var controller: AgenticWalletController
    @State private var copiedAddress = false
    @State private var copiedAddressResetTask: Task<Void, Never>?

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
                        HStack(spacing: 8) {
                            Text("Address")
                            Spacer(minLength: 8)
                            Text(short(record.publicKey))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Button {
                                copyAddress(record.publicKey)
                            } label: {
                                Image(systemName: copiedAddress ? "checkmark" : "doc.on.doc")
                            }
                            .buttonStyle(.borderless)
                            .foregroundStyle(copiedAddress ? .green : .accentColor)
                            .accessibilityLabel(copiedAddress ? "Copied address" : "Copy wallet address")
                        }
                        LabeledContent("Status", value: record.authenticated ? "Authenticated" : "Disconnected")
                        if let balance = controller.walletBalanceSummary {
                            LabeledContent("Wallet value", value: balance.totalText)
                            LabeledContent("SOL", value: balance.solText)
                            LabeledContent("USDC", value: balance.usdcText)
                        } else {
                            LabeledContent("Balances", value: controller.walletBalanceLoading ? "Loading" : controller.walletBalanceStatus)
                        }
                        Button("Refresh balances") {
                            controller.refreshWalletBalanceSummary()
                        }
                        .disabled(controller.walletBalanceLoading)
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
            .overlay(alignment: .bottom) {
                copiedAddressToast
            }
            .animation(.easeInOut(duration: 0.18), value: copiedAddress)
        }
    }

    @ViewBuilder
    private var copiedAddressToast: some View {
        if copiedAddress {
            Label("Copied address", systemImage: "checkmark")
                .font(.footnote.weight(.semibold))
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(.ultraThinMaterial, in: Capsule())
                .overlay {
                    Capsule().stroke(Color.green.opacity(0.35))
                }
                .padding(.bottom, 12)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    @MainActor
    private func copyAddress(_ address: String) {
        writeAddressToPasteboard(address)
        copiedAddressResetTask?.cancel()
        copiedAddress = true
        copiedAddressResetTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_600_000_000)
            guard !Task.isCancelled else { return }
            copiedAddress = false
            copiedAddressResetTask = nil
        }
    }

    private func writeAddressToPasteboard(_ address: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = address
        #elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(address, forType: .string)
        #endif
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
