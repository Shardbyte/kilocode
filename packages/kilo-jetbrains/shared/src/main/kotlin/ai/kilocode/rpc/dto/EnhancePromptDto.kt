package ai.kilocode.rpc.dto

import kotlinx.serialization.Serializable

@Serializable
data class EnhancePromptAccountDto(
    val id: String,
    val label: String,
)

@Serializable
data class EnhancePromptOptionsDto(
    val providerID: String,
    val modelID: String,
    val profilesEnabled: Boolean,
    val requiresAccountContext: Boolean,
    val allowedContextKinds: List<String>,
    val accounts: List<EnhancePromptAccountDto>,
    val backendGeneration: Long? = null,
)

@Serializable
data class EnhancePromptRequestDto(
    val text: String,
    val providerID: String,
    val modelID: String,
    val sourceSessionID: String? = null,
    val accountID: String? = null,
    val legacy: Boolean = false,
    val backendGeneration: Long? = null,
)
