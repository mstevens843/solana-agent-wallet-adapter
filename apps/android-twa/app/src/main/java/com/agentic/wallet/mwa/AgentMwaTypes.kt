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
)

data class AgentMwaBridgeRequest(
    val id: String,
    val kind: String,
    val payloadData: String,
    val payloadEncoding: String,
    val cluster: AgentCluster,
    val summary: String?,
)
