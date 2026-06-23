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
            "devnet" -> Devnet
            else -> MainnetBeta
        }

        fun requireSupported(value: String?): AgentCluster = when (value) {
            // Mainnet-only product: an absent/blank cluster defaults to mainnet-beta, never devnet.
            "mainnet-beta", "mainnet", null, "" -> MainnetBeta
            "devnet" -> Devnet
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

data class AgentWalletBalanceSummary(
    val totalText: String,
    val solText: String,
    val usdcText: String,
    val statusText: String,
)

data class AgentMwaAuthRecord(
    val publicKeyBase58: String = "",
    val publicKeyBytes: ByteArray = ByteArray(0),
    val authToken: String = "",
    val walletUriBase: String = "",
    val walletIcon: String = "",
    val walletPackage: String = "",
    val walletType: Int = 0,
    val accountLabel: String = "",
    val cluster: AgentCluster = AgentCluster.MainnetBeta,
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
    // "tx-memo-proof" indicates the Phantom/Solflare/Seed-Vault ownership-proof
    // fallback: those wallets either don't implement sign_messages over MWA or do
    // so in a way that hangs/returns CancellationException, so the dApp built a
    // memo-only legacy transaction whose memo data is a fixed-size hashed envelope
    // of the proof message (see [MemoProofRouter.buildProofMemo]) and asked the
    // wallet to sign it. The envelope is the prefix `"Agentic plan review proof v1
    // SHA-256: "` followed by the lowercase hex of `sha256(utf8(message))`, which
    // keeps the total tx under Solana's 1232-byte PACKET_DATA_SIZE limit even for
    // multi-KB plan-review messages (a literal-bytes memo previously produced a
    // 1673-byte tx that Seed Vault rejected as "Invalid transaction"). The signed
    // transaction is NEVER broadcast. [transactionBase64] is the full signed tx so
    // the server can extract the memo, recompute the digest of `proofMemoText`,
    // and ed25519-verify the signature against the transaction message bytes. See
    // `apps/render-web/src/cloud/auth.ts` verifyWalletSignature; the JS bridge
    // forwards this token to the verifier as `proofEncoding`.
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
