// Claude API Client v1
// Provides Claude API access with usage tracking for applets injected into Steelhead pages.
// Runs in MAIN world; API key must be set via setApiKey() after injection.

const ClaudeAPI = (() => {
  'use strict';

  let apiKey = null;
  let totalUsage = { inputTokens: 0, outputTokens: 0, cost: 0 };

  // Pricing for claude-3-sonnet (USD per million tokens)
  const PRICING = { inputPerMTok: 3, outputPerMTok: 15 };
  const MODEL = 'claude-3-sonnet-20240229';

  function setApiKey(key) { apiKey = key; }

  async function sendMessage(messages, options = {}) {
    if (!apiKey) throw new Error('Claude API key not configured');

    const body = {
      model: options.model || MODEL,
      max_tokens: options.maxTokens || 4096,
      messages
    };

    if (options.system) body.system = options.system;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Claude API error ${response.status}: ${err.error?.message || response.statusText}`);
    }

    const result = await response.json();

    // Track usage
    const usage = result.usage || {};
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cost = (inputTokens * PRICING.inputPerMTok / 1_000_000) +
                 (outputTokens * PRICING.outputPerMTok / 1_000_000);

    totalUsage.inputTokens += inputTokens;
    totalUsage.outputTokens += outputTokens;
    totalUsage.cost += cost;

    return {
      content: result.content?.[0]?.text || '',
      usage: { inputTokens, outputTokens, cost },
      totalUsage: { ...totalUsage }
    };
  }

  // Send a message that includes a PDF document
  async function sendWithPDF(pdfBase64, prompt, options = {}) {
    const messages = [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 }
        },
        { type: 'text', text: prompt }
      ]
    }];
    return sendMessage(messages, options);
  }

  function getUsage() { return { ...totalUsage }; }

  function resetUsage() { totalUsage = { inputTokens: 0, outputTokens: 0, cost: 0 }; }

  function formatUsage(usage) {
    const u = usage || totalUsage;
    const tokens = (u.inputTokens + u.outputTokens).toLocaleString();
    const cost = u.cost < 0.01 ? '<$0.01' : '$' + u.cost.toFixed(2);
    return `${tokens} tokens · ${cost} USD`;
  }

  return { setApiKey, sendMessage, sendWithPDF, getUsage, resetUsage, formatUsage };
})();

if (typeof window !== 'undefined') window.ClaudeAPI = ClaudeAPI;
