import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { HttpError, requireEnv } from './http';
import type { SourceFormat } from './validation';
import {
  TRANSCRIBE_SCHEMA,
  TRANSCRIBE_SYSTEM,
  TRANSCRIBE_TOOL,
  parseTranscription,
  parseTranslation,
  translateSystem,
  type Transcription,
} from './parse';

const client = new BedrockRuntimeClient({});

async function converse(input: ConverseCommandInput): Promise<ConverseCommandOutput> {
  try {
    return await client.send(new ConverseCommand(input));
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'ThrottlingException' || name === 'ServiceUnavailableException' || name === 'ModelNotReadyException') {
      throw new HttpError(429, 'The reader is busy right now. Try again in a moment.');
    }
    console.error('Bedrock error', err);
    if (name === 'AccessDeniedException' || name === 'ResourceNotFoundException') {
      throw new HttpError(503, 'Text reading is not enabled for this AWS account yet. Enable model access in Amazon Bedrock.');
    }
    if (name === 'ValidationException') {
      throw new HttpError(422, "That file couldn't be read. Try a clear JPG or PNG photo.");
    }
    throw err;
  }
}

export async function transcribe(bytes: Uint8Array, format: SourceFormat): Promise<Transcription> {
  const source: ContentBlock =
    format === 'pdf'
      ? { document: { format: 'pdf', name: 'handwritten-note', source: { bytes } } }
      : { image: { format, source: { bytes } } };

  const res = await converse({
    modelId: requireEnv('EXTRACT_MODEL_ID'),
    system: [{ text: TRANSCRIBE_SYSTEM }],
    messages: [{ role: 'user', content: [source, { text: 'Transcribe this handwritten note.' }] }],
    inferenceConfig: { maxTokens: 4096, temperature: 0 },
    toolConfig: {
      tools: [
        {
          toolSpec: {
            name: TRANSCRIBE_TOOL,
            description: 'Save the transcription of the handwritten note.',
            inputSchema: { json: TRANSCRIBE_SCHEMA },
          },
        },
      ],
      toolChoice: { tool: { name: TRANSCRIBE_TOOL } },
    },
  });
  return parseTranscription(res);
}

export async function translate(text: string, target: string): Promise<string> {
  const res = await converse({
    modelId: requireEnv('TRANSLATE_MODEL_ID'),
    system: [{ text: translateSystem(target) }],
    messages: [{ role: 'user', content: [{ text: `<note>\n${text}\n</note>` }] }],
    inferenceConfig: { maxTokens: 4096, temperature: 0.2 },
  });
  return parseTranslation(res);
}
