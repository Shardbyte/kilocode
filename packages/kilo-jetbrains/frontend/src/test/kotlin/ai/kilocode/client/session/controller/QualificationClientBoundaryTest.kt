package ai.kilocode.client.session.controller

import ai.kilocode.rpc.dto.EnhancePromptAccountDto
import ai.kilocode.rpc.dto.EnhancePromptOptionsDto
import ai.kilocode.rpc.dto.EnhancePromptRequestDto
import kotlinx.coroutines.CompletableDeferred

class QualificationClientBoundaryTest : SessionControllerTestBase() {

    fun `test profiles enabled sends only selected account id and prepared model`() {
        val opts = EnhancePromptOptionsDto(
            "openai", "gpt-5-mini", true, true, listOf("legacy", "account"),
            listOf(EnhancePromptAccountDto("acct_safe", "Work")), backendGeneration = 17,
        )
        val choice = enhanceChoices(opts).single { it.accountID == "acct_safe" }

        assertEquals(EnhancePromptRequestDto("draft", "openai", "gpt-5-mini", accountID = "acct_safe", backendGeneration = 17), enhanceRequest("draft", opts, null, choice))
    }

    fun `test profiles disabled keeps legacy provider auth without account fields`() {
        val controller = controller()
        rpc.enhanceOptions = EnhancePromptOptionsDto("openai", "gpt-5-mini", false, false, listOf("legacy"), emptyList())

        edt { controller.enhancePrompt("draft") {} }
        flush()

        assertEquals(EnhancePromptRequestDto("draft", "openai", "gpt-5-mini"), rpc.enhancements.single().second)
    }

    fun `test unsupported legacy response does not invent an account context`() {
        val controller = controller()
        rpc.enhanceOptions = EnhancePromptOptionsDto("openai", "gpt-5-mini", true, true, listOf("future-kind"), emptyList())

        edt { controller.enhancePrompt("draft") {} }
        flush()

        assertEquals(EnhancePromptRequestDto("draft", "openai", "gpt-5-mini"), rpc.enhancements.single().second)
    }

    fun `test account picker cancellation creates no generation request`() {
        val opts = EnhancePromptOptionsDto(
            "openai", "gpt-5-mini", true, true, listOf("legacy", "account"),
            listOf(EnhancePromptAccountDto("acct_safe", "Work")), backendGeneration = 17,
        )

        val choice = chooseEnhanceChoice(opts) { -1 }

        assertNull(choice)
        assertNull(enhanceRequest("draft", opts, null, choice))
    }

    fun `test active session switch preserves the prepared session model and generation`() {
        val controller = controller(id = "ses_prepared")
        val gate = CompletableDeferred<Unit>()
        rpc.enhancePrepareGate = gate

        edt { controller.enhancePrompt("draft") {} }
        settle()
        edt { controller.openSession(session("ses_new", "New session")) }
        gate.complete(Unit)
        flush()

        assertEquals(
            EnhancePromptRequestDto("draft", "openai", "gpt-5-mini", sourceSessionID = "ses_prepared"),
            rpc.enhancements.single().second,
        )
    }
}
