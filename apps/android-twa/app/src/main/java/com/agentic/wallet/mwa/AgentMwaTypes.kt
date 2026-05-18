package com.agentic.wallet.mwa

import com.solana.mobilewalletadapter.clientlib.Blockchain
import com.solana.mobilewalletadapter.clientlib.Solana

enum class AgentCluster(val id: String) {
    MainnetBeta("mainnet-beta"),
    Devnet("devnet"),
    Testnet("testnet");

    fun blockchain(): Blockchain = when (this) {
        MainnetBeta -> Solana.Mainnet
        Devnet -> Solana.Devnet
        Testnet -> Solana.Testnet
    }

    fun rpcUrl(): String = when (this) {
        MainnetBeta -> "https://api.mainnet-beta.solana.com"
        Devnet -> "https://api.devnet.solana.com"
        Testnet -> "https://api.testnet.solana.com"
    }

    companion object {
        fun fromId(value: String?): AgentCluster = when (value) {
            "mainnet-beta", "mainnet" -> MainnetBeta
            "testnet" -> Testnet
            else -> Devnet
        }

        fun requireSupported(value: String?): AgentCluster = when (value) {
            "mainnet-beta", "mainnet" -> MainnetBeta
            "devnet", null, "" -> Devnet
            "testnet" -> Testnet
            else -> throw MwaOperationException(
                "CLUSTER_MISMATCH",
                "Android native MWA supports mainnet-beta, devnet, and testnet; bridge requested $value.",
            )
        }
    }
}

data class AgentMwaIdentity(
    val name: String,
    val uri: String,
    val iconUri: String,
)

data class AgentMwaAuthRecord(
    val publicKeyBase58: String = "",
    val publicKeyBytes: ByteArray = ByteArray(0),
    val authToken: String = "",
    val walletUriBase: String = "",
    val walletPackage: String = "",
    val walletType: Int = 0,
    val accountLabel: String = "",
    val cluster: AgentCluster = AgentCluster.Devnet,
    val timestampUnixSeconds: Long = 0L,
    val authenticated: Boolean = false,
    val capabilitiesCsv: String = "",
) {
    fun hasUsableAuthorization(): Boolean = publicKeyBase58.isNotBlank() && authToken.isNotBlank()
}

data class AgentMwaSigningResult(
    val signature: String,
    val txid: String? = null,
    // Encoding of the signed payload. Default "utf8" matches the historical contract
    // where signature is ed25519 over UTF-8 message bytes (sign-message path) or over
    // a transaction's message bytes (sign-and-send / sign-transaction paths — the
    // server reconstructs the payload itself).
    //
    // "transaction_memo" indicates the Phantom/Solflare ownership-proof fallback:
    // because those wallets don't implement sign_messages over MWA, the dApp built
    // a memo-only legacy transaction containing the proof string as the memo data
    // and asked the wallet to sign it. The signed transaction is NEVER broadcast.
    // [transactionBase64] is the full signed transaction so the server can extract
    // the memo and ed25519-verify the signature against the transaction message
    // bytes. See `apps/render-web/src/cloud/auth.ts` verifyWalletSignature.
    val encoding: String = "utf8",
    val transactionBase64: String? = null,
)

/**
 * Full Sign-In-With-Solana (SIWS / MWA 2.0 Auth 2.0) result.
 *
 * Returned by [MwaController.connectWithSignIn]. Mirrors what
 * grant-godot's connectWalletSiws and Unity's LastSignInResult expose
 * so the JS bridge can surface the same set of fields:
 *  - [signature]: base58 ed25519 signature
 *  - [signedMessage]: base64 of the CAIP-122 message that was signed
 *  - [publicKeyBase58]: the signing wallet's pubkey
 *  - [accountLabel]: human-readable label (e.g. "cofeelme.skr")
 *  - [chains]: cluster identifiers the wallet returned in AuthResult.accounts[0].chains
 *  - [features]: feature identifiers the wallet supports
 *  - [authToken]: MWA authorization token (parity with PR #3 getAuthToken)
 *  - [walletPackage]: e.g. "app.phantom"
 *  - [cluster]: the AgentCluster id the auth landed on
 *  - [path]: "native" when the wallet returned sign_in_result directly,
 *            "fallback" when the clientlib used the sign_messages CAIP-122 fallback
 */
data class AgentMwaSignInResult(
    val signature: String,
    val signedMessage: String,
    val publicKeyBase58: String,
    val accountLabel: String,
    val chains: List<String>,
    val features: List<String>,
    val authToken: String,
    val walletPackage: String,
    val cluster: String,
    val path: String,
)

data class AgentMwaBridgeRequest(
    val id: String,
    val kind: String,
    val payloadData: String,
    val payloadEncoding: String,
    val cluster: AgentCluster,
    val rpcUrl: String?,
    val summary: String?,
)
