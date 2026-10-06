package ai.kilocode.backend.app

import ai.kilocode.backend.testing.MockCliServer
import ai.kilocode.backend.testing.TestLog
import ai.kilocode.rpc.dto.EnhancePromptRequestDto
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class QualificationClientBoundaryTest {

    @Test
    fun `deleted prepared account is delegated to backend rejection at generation`() = runBlocking {
        val port = mock.start()
        val chat = KiloBackendChatManager(scope, TestLog())
        chat.start(OkHttpClient(), port, MutableSharedFlow())
        val prepared = chat.prepareEnhancePrompt("/test/project")
        mock.providerAccounts = """{"accounts":[]}"""
        mock.enhanceStatus = 404
        val req = EnhancePromptRequestDto(
            "draft", prepared.providerID, prepared.modelID, accountID = "acct_1", backendGeneration = prepared.backendGeneration,
        )

        val err = assertFailsWith<RuntimeException> { chat.enhancePrompt("/test/project", req) }

        assertEquals(1, mock.requestCount("/provider-accounts"))
        assertEquals(1, mock.requestCount("/enhance-prompt"))
        assertEquals(
            """{"text":"draft","model":{"providerID":"openai","modelID":"gpt-5-mini"}, "accountContext":{"kind":"account","providerID":"openai","authMode":"chatgpt-oauth","accountID":"acct_1"}}""",
            mock.lastEnhanceBody,
        )
        assertEquals("Enhance prompt unavailable (HTTP 404). Check the configured model and account settings.", err.message)
    }

    private val mock = MockCliServer()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @AfterTest
    fun tearDown() {
        scope.cancel()
        mock.close()
    }
}
