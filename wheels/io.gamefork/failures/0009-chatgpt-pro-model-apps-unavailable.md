---
id: failure-0009
namespace: io.gamefork
title: ChatGPT Pro models do not support Apps, which can masquerade as an MCP server failure
summary: A ChatGPT Pro subscription may use Apps, but a Pro model cannot call them. The app can appear attached and its tools can scan successfully while no tool call reaches the MCP server; switching a fresh chat to a non-Pro model restores the same app without server changes.
status: active
tags: [openai, chatgpt, apps, mcp, pro-model, model-compatibility, client-bug, tool-discovery]
created: 2026-07-20
source: io.gamefork (promoted from a private wheel)
origin: Reproduced and fixed in a 2026-07-20 ChatGPT Web integration test, then checked against OpenAI's public Apps in ChatGPT model-compatibility documentation.
stack: [chatgpt, apps, mcp]
supersedes: null
superseded_by: null
observed_by: chatgpt-pro-model
verified: 2026-07-20
---

## Context

A custom MCP-backed ChatGPT app was healthy: app creation discovered exactly the intended
tool, direct MCP initialization and tool calls succeeded, and the app appeared attached to
the conversation. Yet prompts in that conversation never invoked the tool and sometimes
produced plausible-looking answers without server data.

## Trigger

The test used a **Pro model** because the account's **Pro subscription** supports Apps. These
are separate capability checks: plan access permits installing and using Apps, while the
selected model still determines whether an App can be called.

## Detection

- The app chip is visible, but ChatGPT reports `connector is not available in this chat` or
  `actions aren't exposed in this chat session`.
- Tool discovery succeeds in app settings, but the conversation shows no tool call and the
  MCP server receives no request for that turn.
- The model may still invent a plausible catalog or search result, so answer quality alone
  cannot prove that the connector ran.
- The same app immediately emits tool calls in a fresh conversation using a non-Pro model.

## Failure

The first diagnostic path treated the symptom as a connector regression, streaming timeout,
or server availability problem. The actual constraint was model compatibility: OpenAI's
Apps documentation excludes Pro models even though Pro subscription accounts can use Apps.
Conflating the subscription tier with the selected model makes a client-side capability gap
look exactly like a dead MCP server.

## Consequences

- **Fix**: start a fresh conversation with a non-Pro model (for example, an Instant or
  Thinking option), explicitly attach the app, and rerun the same prompt before changing the
  connector or server.
- **Diagnostic order**: check model compatibility, confirm that the UI recorded a tool call,
  inspect whether the server received the request, and only then investigate transport,
  authentication, or server response handling.
- **Fabrication guard**: integration prompts should say not to infer results when the tool
  cannot actually be called. Validate the call trace separately from the prose answer.
- **Verified result**: after switching to a non-Pro model in a fresh Web conversation, four
  independent browse/search/access-boundary tests all invoked the tool and returned the
  expected results. No server change or connector re-creation was required.
