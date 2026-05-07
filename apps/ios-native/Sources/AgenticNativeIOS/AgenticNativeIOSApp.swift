import SwiftUI

@main
struct AgenticNativeIOSApp: App {
    @StateObject private var controller = AgenticWalletController()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(controller)
                .onOpenURL { url in
                    controller.handleOpenURL(url)
                }
        }
    }
}
