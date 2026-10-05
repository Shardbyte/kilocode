package ai.kilocode.client.session.controller

import ai.kilocode.rpc.dto.EnhancePromptAccountDto
import ai.kilocode.rpc.dto.EnhancePromptOptionsDto
import ai.kilocode.rpc.dto.EnhancePromptRequestDto
import com.intellij.openapi.application.ApplicationManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking

class PromptEnhancerTest : SessionControllerTestBase() {

    fun `test standalone choices include only explicit allowed account contexts`() {
        val opts = EnhancePromptOptionsDto(
            "openai",
            "gpt-5-mini",
            profilesEnabled = true,
            requiresAccountContext = true,
            allowedContextKinds = listOf("legacy", "account", "session"),
            accounts = listOf(EnhancePromptAccountDto("acct_work", "Work")),
        )

        val choices = enhanceChoices(opts)

        assertEquals(2, choices.size)
        assertTrue(choices[0].legacy)
        assertNull(choices[0].accountID)
        assertEquals("acct_work", choices[1].accountID)
        assertFalse(choices[1].legacy)
        assertTrue(enhanceChoices(opts.copy(allowedContextKinds = listOf("session"))).isEmpty())
        assertNull(chooseEnhanceChoice(opts) { -1 })
        assertNull(enhanceRequest("help", opts, null))
    }

    fun `test standalone non OpenAI model uses prepared model without account context`() {
        val controller = controller()
        rpc.enhanceOptions = EnhancePromptOptionsDto("anthropic", "claude-sonnet", false, false, emptyList(), emptyList())

        edt { controller.enhancePrompt("explain this") {} }
        flush()

        assertEquals(
            listOf("/test" to EnhancePromptRequestDto("explain this", "anthropic", "claude-sonnet")),
            rpc.enhancements,
        )
    }

    fun `test standalone OpenAI with profiles disabled preserves legacy auth without chooser`() {
        val controller = controller()
        rpc.enhanceOptions = EnhancePromptOptionsDto("openai", "gpt-5-mini", false, false, listOf("legacy"), emptyList())

        edt { controller.enhancePrompt("make a plan") {} }
        flush()

        assertEquals(
            listOf("/test" to EnhancePromptRequestDto("make a plan", "openai", "gpt-5-mini")),
            rpc.enhancements,
        )
    }

    fun `test missing explicit choices leaves account requirement to backend`() {
        val controller = controller()
        rpc.enhanceOptions = EnhancePromptOptionsDto("openai", "gpt-5-mini", true, true, emptyList(), emptyList())

        edt { controller.enhancePrompt("make a plan") {} }
        flush()

        assertEquals(
            listOf("/test" to EnhancePromptRequestDto("make a plan", "openai", "gpt-5-mini")),
            rpc.enhancements,
        )
    }

    fun `test enhance prompt completes on EDT with workspace directory`() {
        val controller = controller(id = "ses_existing")
        rpc.enhanced = "Use a focused implementation plan"
        var result: Result<String>? = null

        edt {
            controller.enhancePrompt("make a plan") {
                assertTrue(ApplicationManager.getApplication().isDispatchThread)
                result = it
            }
        }
        flush()

        assertEquals(listOf("/test" to EnhancePromptRequestDto("make a plan", "openai", "gpt-5-mini", sourceSessionID = "ses_existing")), rpc.enhancements)
        assertEquals("Use a focused implementation plan", result!!.getOrThrow())
    }

    fun `test enhance prompt captures the existing source session`() {
        val controller = controller(id = "ses_source")

        edt { controller.enhancePrompt("make a plan") {} }
        flush()

        assertEquals(listOf("/test" to EnhancePromptRequestDto("make a plan", "openai", "gpt-5-mini", sourceSessionID = "ses_source")), rpc.enhancements)
    }

    fun `test enhance prompt keeps captured session when controller switches sessions during prepare`() {
        val controller = controller(id = "ses_source")
        val gate = CompletableDeferred<Unit>()
        rpc.enhancePrepareGate = gate

        edt { controller.enhancePrompt("make a plan") {} }
        settle()
        edt { controller.openSession(session("ses_new", "New session")) }
        runBlocking { gate.complete(Unit) }
        flush()

        assertEquals("ses_source", rpc.enhancements.single().second.sourceSessionID)
    }

    fun `test enhance prompt records telemetry`() {
        val controller = controller(id = "ses_existing")

        edt { controller.enhancePrompt("make a plan") {} }
        flush()

        val click = appRpc.telemetry.single { it.event == "Prompt Enhance Clicked" }
        assertEquals("short", click.properties["textLength"])
        val done = appRpc.telemetry.single { it.event == "Prompt Enhanced" }
        assertEquals("short", done.properties["textLength"])
    }

    fun `test enhance prompt reports failure without changing session state`() {
        val controller = controller(id = "ses_existing")
        rpc.enhanceThrows = IllegalStateException("provider unavailable")
        val before = edt { controller.model.state }
        var result: Result<String>? = null

        edt { controller.enhancePrompt("make a plan") { result = it } }
        flush()

        assertEquals("provider unavailable", result!!.exceptionOrNull()!!.message)
        assertSame(before, edt { controller.model.state })
    }

    fun `test enhance prompt cancels pending completions on disposal`() {
        val controller = controller(id = "ses_existing")
        val gate = CompletableDeferred<Unit>()
        val results = mutableListOf<Result<String>>()
        rpc.enhanceGate = gate

        edt {
            controller.enhancePrompt("make a plan") {
                assertTrue(ApplicationManager.getApplication().isDispatchThread)
                results.add(it)
            }
            controller.enhancePrompt("rewrite a plan") {
                assertTrue(ApplicationManager.getApplication().isDispatchThread)
                results.add(it)
            }
        }
        settle()
        controller.dispose()

        assertEquals(2, results.size)
        assertTrue(results.all { it.exceptionOrNull() is CancellationException })

        runBlocking { gate.complete(Unit) }
        settle()

        assertEquals(2, results.size)
    }
}
