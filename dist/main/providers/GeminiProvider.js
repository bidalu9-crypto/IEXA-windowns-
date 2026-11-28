"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeminiProvider = void 0;
const DiagnosticDecoder_1 = require("../encoding/DiagnosticDecoder");
const ProviderError_1 = require("./ProviderError");
// =============================================================================
// iExA PC - Gemini Provider
// Mirrors iOS GeminiProvider.swift + GeminiAgentProvider.swift
// Uses Google Gemini API with SSE streaming
// =============================================================================
const types_1 = require("./types");
const stream_utils_1 = require("./stream-utils");
class GeminiProvider {
    name = 'gemini';
    model;
    apiKey;
    userAgent;
    thinkingLevel;
    defaultMaxTokens = 64000;
    constructor(config) {
        this.model = config.model;
        this.apiKey = config.apiKey;
        this.userAgent = config.userAgent;
        this.thinkingLevel = config.thinkingLevel || 'medium';
    }
    async *streamMessage(messages, systemPrompt, tools, maxTokens = 64000, signal) {
        const contents = this.convertMessages(messages);
        const geminiTools = this.convertTools(tools);
        const thinkingBudgetMap = {
            off: 0,
            low: 1024,
            medium: 8192,
            high: 16384,
            xhigh: 32768,
            max: 32768,
            ultra: 32768,
        };
        const thinkingBudget = thinkingBudgetMap[this.thinkingLevel] ?? 8192;
        const generationConfig = {
            maxOutputTokens: maxTokens,
            temperature: 0.7,
        };
        // Gemini 2.5 thinking models
        if (thinkingBudget > 0) {
            generationConfig.thinkingConfig = { thinkingBudget };
        }
        else {
            generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }
        const body = {
            contents,
            generationConfig,
        };
        if (systemPrompt) {
            body.systemInstruction = {
                parts: [{ text: systemPrompt }],
            };
        }
        if (geminiTools.length > 0) {
            body.tools = [{ functionDeclarations: geminiTools }];
        }
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
        const response = await (0, stream_utils_1.fetchWithRetry)(url, {
            method: 'POST',
            userAgent: this.userAgent,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
        });
        if (!response.ok) {
            const errorText = await (0, DiagnosticDecoder_1.readDiagnosticResponse)(response);
            throw ProviderError_1.ProviderError.http(response.status, errorText, 'Gemini');
        }
        const reader = response.body?.getReader();
        if (!reader)
            throw new Error('No response body');
        let startedText = false;
        let currentToolName = '';
        let currentToolArgs = '';
        let inputTokens = 0;
        let outputTokens = 0;
        const emittedFunctionCalls = new Set();
        try {
            for await (const frame of (0, stream_utils_1.readSSEFrames)(reader, signal)) {
                const data = frame.data;
                if (data === '[DONE]') {
                    yield { type: 'done', stopReason: 'endTurn' };
                    return;
                }
                try {
                    const event = JSON.parse(data);
                    ProviderError_1.ProviderError.throwIfErrorFrame(event, frame.event);
                    if (!event.candidates?.[0])
                        continue;
                    const candidate = event.candidates[0];
                    const content = candidate.content;
                    if (content?.parts) {
                        for (const part of content.parts) {
                            if (part.text) {
                                if (!startedText) {
                                    startedText = true;
                                    yield { type: 'contentBlockStart', block: { type: 'text' } };
                                }
                                yield { type: 'textDelta', text: part.text };
                            }
                            else if (part.functionCall) {
                                currentToolName = part.functionCall.name;
                                currentToolArgs = JSON.stringify(part.functionCall.args || {});
                                const signature = `${currentToolName}:${currentToolArgs}`;
                                // Some Gemini-compatible SSE relays repeat the complete
                                // functionCall in multiple candidate chunks. Treat the
                                // same name+arguments pair as one call, otherwise the tool
                                // executes twice with different synthetic IDs.
                                if (emittedFunctionCalls.has(signature))
                                    continue;
                                emittedFunctionCalls.add(signature);
                                const toolId = 'gemini_tool_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                                // Live step first (iOS-style), then complete
                                yield {
                                    type: 'contentBlockStart',
                                    block: { type: 'toolUse', id: toolId, name: currentToolName },
                                };
                                yield {
                                    type: 'toolInputDelta',
                                    name: currentToolName,
                                    accumulated: currentToolArgs,
                                    id: toolId,
                                };
                                yield {
                                    type: 'toolCallComplete',
                                    id: toolId,
                                    name: currentToolName,
                                    args: part.functionCall.args || {},
                                };
                            }
                        }
                    }
                    // Finish reason
                    if (candidate.finishReason) {
                        let agentStopReason = 'endTurn';
                        if (candidate.finishReason === 'STOP')
                            agentStopReason = 'endTurn';
                        else if (candidate.finishReason === 'MAX_TOKENS')
                            agentStopReason = 'maxTokens';
                        // Gemini's promptTokenCount already includes cachedContentTokenCount,
                        // the same shape the OpenAI path and Anthropic normalisation use:
                        // inputTokens is the whole prompt, the cached span sits inside it.
                        if (event.usageMetadata) {
                            const reported = Number(event.usageMetadata.promptTokenCount || 0);
                            const cached = Number(event.usageMetadata.cachedContentTokenCount || 0);
                            const cacheRead = Number.isFinite(cached) && cached > 0 ? Math.min(cached, reported) : 0;
                            inputTokens = reported;
                            outputTokens = event.usageMetadata.candidatesTokenCount || 0;
                            yield { type: 'usage', usage: cacheRead > 0
                                    ? { inputTokens, outputTokens, cacheReadInputTokens: cacheRead }
                                    : { inputTokens, outputTokens } };
                        }
                        yield { type: 'done', stopReason: agentStopReason };
                        return;
                    }
                }
                catch (e) {
                    if (e instanceof SyntaxError)
                        continue;
                    throw e;
                }
            }
            throw new ProviderError_1.ProviderError('STREAM_TERMINATED', 'Provider stream terminated before completion', true);
        }
        finally {
            reader.releaseLock();
        }
    }
    convertMessages(messages) {
        const contents = [];
        for (const msg of messages) {
            const parts = [];
            for (const part of msg.parts) {
                if (part.type === 'text') {
                    parts.push({ text: part.text });
                }
                else if (part.type === 'toolUse') {
                    parts.push({
                        functionCall: {
                            name: part.name,
                            args: part.input,
                        },
                    });
                }
                else if (part.type === 'toolResult') {
                    parts.push({
                        functionResponse: {
                            name: part.name,
                            response: { result: part.content },
                        },
                    });
                }
                else if (part.type === 'imageData') {
                    parts.push({
                        inlineData: {
                            mimeType: part.mimeType,
                            data: part.data.toString('base64'),
                        },
                    });
                }
            }
            contents.push({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: parts.length > 0 ? parts : [{ text: '' }],
            });
        }
        return contents;
    }
    convertTools(tools) {
        return tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: {
                type: 'object',
                properties: Object.fromEntries(Object.entries(tool.parameters).map(([key, param]) => [
                    key,
                    { ...(0, types_1.toolParamSchema)(param), type: param.type.toUpperCase() },
                ])),
                required: tool.required,
            },
        }));
    }
}
exports.GeminiProvider = GeminiProvider;
//# sourceMappingURL=GeminiProvider.js.map