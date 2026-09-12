import OpenAI from "openai";
import Groq from "groq-sdk";

export class LLMIndisponibleError extends Error {
  constructor() {
    super("Fonctionnalite IA indisponible : connexion internet requise.");
    this.name = "LLMIndisponibleError";
  }
}

const CODES_ERREUR_RESEAU = new Set(["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"]);

export function estErreurReseau(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { code?: string; cause?: { code?: string } };
  if (e.code && CODES_ERREUR_RESEAU.has(e.code)) return true;
  if (e.cause?.code && CODES_ERREUR_RESEAU.has(e.cause.code)) return true;
  return /fetch failed/i.test(e.message);
}

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LLMOptions {
  messages: Message[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

const OPENAI_FALLBACK_CODES = new Set([
  "billing_not_active",
  "invalid_api_key",
  "account_deactivated",
]);

function shouldFallback(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { status?: number; code?: string; type?: string };
  if (e.code && OPENAI_FALLBACK_CODES.has(e.code)) return true;
  if (e.type && OPENAI_FALLBACK_CODES.has(e.type)) return true;
  if (e.status === 401) return true;
  return false;
}

export async function invokeLLM(options: LLMOptions): Promise<string> {
  const { messages, model = "gpt-4o", temperature = 0.3, maxTokens = 2000 } = options;

  if (process.env.OPENAI_API_KEY) {
    try {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await client.chat.completions.create({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
      });
      return response.choices[0]?.message?.content ?? "Réponse non disponible";
    } catch (err) {
      if (estErreurReseau(err)) throw new LLMIndisponibleError();
      if (!shouldFallback(err)) throw err;
      console.warn("[LLM] OpenAI indisponible, bascule sur Groq:", (err as Error).message);
    }
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    throw new Error("Aucun fournisseur LLM configuré (OPENAI_API_KEY ou GROQ_API_KEY requis).");
  }

  try {
    const client = new Groq({ apiKey: groqKey });
    const response = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages,
      temperature,
      max_tokens: maxTokens,
    });
    return response.choices[0]?.message?.content ?? "Réponse non disponible";
  } catch (err) {
    if (estErreurReseau(err)) throw new LLMIndisponibleError();
    throw err;
  }
}
