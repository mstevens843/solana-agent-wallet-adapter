import Foundation

enum AgenticWalletBalanceService {
    private static let solMint = "So11111111111111111111111111111111111111112"
    private static let usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    private static let jupiterLitePriceURL = URL(string: "https://lite-api.jup.ag/price/v3")!

    static func load(record: AgenticAuthRecord) async throws -> AgenticWalletBalanceSummary {
        async let solLamports = rpcNumber(
            cluster: record.cluster,
            method: "getBalance",
            params: [
                record.publicKey,
                ["commitment": "confirmed"],
            ],
            resultPath: ["value"]
        )
        async let usdcAmount = loadUsdcAmount(record: record)
        let sol = try await solLamports / 1_000_000_000
        let usdc = try await usdcAmount
        let prices = record.cluster == .mainnetBeta
            ? ((try? await loadJupiterLitePrices(mints: [solMint, usdcMint])) ?? [:])
            : [:]
        let solPrice = prices[solMint]
        let usdcPrice = prices[usdcMint] ?? (record.cluster == .mainnetBeta ? 1 : nil)
        let priced = solPrice != nil || usdcPrice != nil
        let totalUsd = (solPrice.map { sol * $0 } ?? 0) + (usdcPrice.map { usdc * $0 } ?? 0)
        let partial = (sol > 0 && solPrice == nil) || (usdc > 0 && usdcPrice == nil)
        return AgenticWalletBalanceSummary(
            totalText: priced ? "\(usdText(totalUsd))\(partial ? "+" : "")" : "USD unavailable",
            solText: amountText(sol, symbol: "SOL", maximumFractionDigits: sol >= 1 ? 4 : 6),
            usdcText: amountText(usdc, symbol: "USDC", maximumFractionDigits: 2, minimumFractionDigits: 2),
            statusText: priced
                ? (partial ? "USD value from Jupiter Price API; some prices unavailable." : "USD value from Jupiter Price API.")
                : "Native fallback shows token amounts only."
        )
    }

    private static func loadJupiterLitePrices(mints: [String]) async throws -> [String: Double] {
        var components = URLComponents(url: jupiterLitePriceURL, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "ids", value: Array(Set(mints)).joined(separator: ","))
        ]
        let (data, response) = try await URLSession.shared.data(from: components.url!)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw AgenticWalletError.invalidCallback("Jupiter Lite Price API returned HTTP \(http.statusCode).")
        }
        let decoded = try JSONSerialization.jsonObject(with: data, options: [])
        guard let root = decoded as? [String: Any] else { return [:] }
        var prices: [String: Double] = [:]
        for mint in mints {
            guard
                let record = root[mint] as? [String: Any],
                let price = number(record["usdPrice"]),
                price >= 0
            else {
                continue
            }
            prices[mint] = price
        }
        return prices
    }

    private static func loadUsdcAmount(record: AgenticAuthRecord) async throws -> Double {
        let response = try await rpcObject(
            cluster: record.cluster,
            method: "getTokenAccountsByOwner",
            params: [
                record.publicKey,
                ["mint": usdcMint],
                ["encoding": "jsonParsed", "commitment": "confirmed"],
            ]
        )
        guard
            let result = response["result"] as? [String: Any],
            let value = result["value"] as? [[String: Any]]
        else {
            return 0
        }
        return value.reduce(0) { total, entry in
            guard
                let account = entry["account"] as? [String: Any],
                let data = account["data"] as? [String: Any],
                let parsed = data["parsed"] as? [String: Any],
                let info = parsed["info"] as? [String: Any],
                let tokenAmount = info["tokenAmount"] as? [String: Any]
            else {
                return total
            }
            if let uiAmount = tokenAmount["uiAmount"] as? Double {
                return total + max(0, uiAmount)
            }
            if let uiAmountString = tokenAmount["uiAmountString"] as? String,
               let parsedAmount = Double(uiAmountString) {
                return total + max(0, parsedAmount)
            }
            return total
        }
    }

    private static func rpcNumber(
        cluster: AgenticCluster,
        method: String,
        params: [Any],
        resultPath: [String]
    ) async throws -> Double {
        let object = try await rpcObject(cluster: cluster, method: method, params: params)
        var current: Any? = object["result"]
        for key in resultPath {
            current = (current as? [String: Any])?[key]
        }
        if let number = current as? NSNumber {
            return number.doubleValue
        }
        if let string = current as? String, let number = Double(string) {
            return number
        }
        return 0
    }

    private static func rpcObject(
        cluster: AgenticCluster,
        method: String,
        params: [Any]
    ) async throws -> [String: Any] {
        var request = URLRequest(url: cluster.rpcURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 12
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        ], options: [])
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw AgenticWalletError.invalidCallback("RPC returned HTTP \(http.statusCode).")
        }
        let decoded = try JSONSerialization.jsonObject(with: data, options: [])
        guard let object = decoded as? [String: Any] else {
            throw AgenticWalletError.invalidCallback("RPC returned an invalid JSON response.")
        }
        if let error = object["error"] as? [String: Any] {
            throw AgenticWalletError.invalidCallback(error["message"] as? String ?? "RPC request failed.")
        }
        return object
    }

    private static func amountText(
        _ amount: Double,
        symbol: String,
        maximumFractionDigits: Int,
        minimumFractionDigits: Int = 0
    ) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = maximumFractionDigits
        formatter.minimumFractionDigits = minimumFractionDigits
        return "\(formatter.string(from: NSNumber(value: max(0, amount))) ?? "0") \(symbol)"
    }

    private static func usdText(_ amount: Double) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .currency
        formatter.maximumFractionDigits = 2
        formatter.minimumFractionDigits = 2
        return formatter.string(from: NSNumber(value: max(0, amount))) ?? "$0.00"
    }

    private static func number(_ value: Any?) -> Double? {
        if let number = value as? NSNumber {
            return number.doubleValue
        }
        if let string = value as? String {
            return Double(string)
        }
        return nil
    }
}
