const fs = require('fs');

const path = 'src/routes/assets.routes.js';
let source = fs.readFileSync(path, 'utf8');

function replaceOnce(before, after, label) {
  if (!source.includes(before)) throw new Error(`Patch target not found: ${label}`);
  source = source.replace(before, after);
}

replaceOnce(
`const responseOutputText = (payload) => {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  return '';
};`,
`const responseOutputText = (payload) => {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
  const parts = [];
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string' && content.text.trim()) {
        parts.push(content.text.trim());
      }
    }
  }
  return parts.join('\\n').trim();
};`,
'responseOutputText aggregation',
);

replaceOnce(
`    const openAiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: \`Bearer \${apiKey}\`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: String(process.env.OPENAI_SMART_EXTRACTION_MODEL || process.env.OPENAI_ASSET_EXTRACTION_MODEL || 'gpt-5-mini'),
        input: [{ role: 'user', content: [{ type: 'input_text', text: extractionPrompt }, ...fileInputs] }],
        max_output_tokens: 1800,
      }),
    });`,
`    const smartExtractionModel = String(process.env.OPENAI_SMART_EXTRACTION_MODEL || process.env.OPENAI_ASSET_EXTRACTION_MODEL || 'gpt-5-mini').trim();
    const openAiRequestBody = {
      model: smartExtractionModel,
      input: [{ role: 'user', content: [{ type: 'input_text', text: extractionPrompt }, ...fileInputs] }],
      text: { format: { type: 'json_object' } },
      max_output_tokens: 4000,
      store: false,
    };
    if (/^(gpt-5|o1|o3|o4)/i.test(smartExtractionModel)) {
      openAiRequestBody.reasoning = { effort: 'low' };
    }

    const openAiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: \`Bearer \${apiKey}\`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(openAiRequestBody),
    });`,
'OpenAI request structured JSON mode',
);

replaceOnce(
`    const parsed = parseSmartExtractionJson(responseOutputText(openAiPayload));
    const normalized = moduleKey === 'asset' ? normalizeSmartExtraction(parsed) : normalizeGenericSmartExtraction(parsed, moduleSpec);`,
`    const outputText = responseOutputText(openAiPayload);
    if (!outputText) {
      console.error('Asset smart extraction returned no output text:', {
        status: openAiPayload?.status || null,
        incompleteDetails: openAiPayload?.incomplete_details || null,
        model: smartExtractionModel,
        usage: openAiPayload?.usage || null,
      });
      const message = openAiPayload?.status === 'incomplete'
        ? 'توقف التحليل قبل اكتمال استخراج البيانات. أعد المحاولة، أو قلّل عدد الصفحات في العملية الواحدة.'
        : 'لم تُرجع خدمة الاستخراج الذكي بيانات قابلة للقراءة. حاول مرة أخرى.';
      return res.status(502).json({ message });
    }

    let parsed;
    try {
      parsed = parseSmartExtractionJson(outputText);
    } catch (parseError) {
      console.error('Asset smart extraction JSON parse failed:', {
        message: parseError?.message || String(parseError),
        status: openAiPayload?.status || null,
        model: smartExtractionModel,
        outputPreview: outputText.slice(0, 500),
      });
      return res.status(502).json({ message: 'تعذر تنظيم البيانات المستخرجة من المستند. أعد المحاولة.' });
    }
    const normalized = moduleKey === 'asset' ? normalizeSmartExtraction(parsed) : normalizeGenericSmartExtraction(parsed, moduleSpec);`,
'parse diagnostics and incomplete handling',
);

fs.writeFileSync(path, source);
console.log('Applied structured JSON output and response diagnostics to smart extraction.');
