import FirebaseCore

public let isCapacitorApp = true

public func configureAgenticFirebaseAnalytics() {
    if FirebaseApp.app() == nil {
        FirebaseApp.configure()
    }
}
