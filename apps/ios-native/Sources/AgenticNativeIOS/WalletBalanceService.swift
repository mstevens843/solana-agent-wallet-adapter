import Foundation

enum AgenticWalletBalanceService {
    private static let usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

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
        return AgenticWalletBalanceSummary(
            totalText: "USD unavailable",
            solText: amountText(sol, symbol: "SOL", maximumFractionDigits: sol >= 1 ? 4 : 6),
            usdcText: amountText(usdc, symbol: "USDC", maximumFractionDigits: 2, minimumFractionDigits: 2),
            statusText: "Native fallback shows token amounts only."
        )
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
}
