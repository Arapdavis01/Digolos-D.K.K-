import { StreamingTextResponse } from "ai";
import OpenAI from "openai";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";

// List of free models on OpenRouter (updated Aug 2026)
const FREE_MODELS = [
  "mistralai/mistral-7b-instruct:free",
  "google/gemma-2-9b-it:free",
  "meta-llama/llama-3.2-3b-instruct:free",
  "microsoft/phi-3-mini-128k-instruct:free",
  "openchat/openchat-7b:free",
  "gryphe/mythomax-l2-13b:free",
  "nousresearch/hermes-2-pro-llama-3-8b:free"
];

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return new Response("API key missing", { status: 500 });

  const openai = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
  });

  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { messages, conversationId } = await req.json();

  let convId = conversationId;
  if (!convId) {
    const { data: conv, error } = await supabase
      .from("conversations")
      .insert({
        user_id: user.id,
        title: messages[0]?.content?.substring(0, 100) || "New chat",
      })
      .select("id")
      .single();
    if (error) return new Response("Conversation creation failed", { status: 500 });
    convId = conv.id;
  }

  const lastUser = messages[messages.length - 1];
  if (lastUser.role === "user") {
    await supabase.from("messages").insert({
      conversation_id: convId,
      role: "user",
      content: lastUser.content,
    });
  }

  const systemPrompt = `You are Digolos D.K.K, a helpful, witty, and knowledgeable AI assistant.`;
  const fullMessages = [{ role: "system", content: systemPrompt }, ...messages];

  // Try each free model until one works
  let completion = null;
  let usedModel = "";
  for (const model of FREE_MODELS) {
    try {
      // Test with a tiny request (non-streaming) to see if model is available
      const test = await openai.chat.completions.create({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      });
      usedModel = model;
      break;
    } catch (err: any) {
      console.warn(`Model ${model} failed: ${err.message}`);
      continue;
    }
  }

  if (!usedModel) {
    return new Response("No free model available. Try again later.", { status: 500 });
  }

  // Now use the working model with streaming
  try {
    const completion = await openai.chat.completions.create({
      model: usedModel,
      stream: true,
      messages: fullMessages as any,
    });

    let assistantContent = "";
    const stream = new ReadableStream({
      async start(controller) {
        for await (const chunk of completion) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) {
            assistantContent += delta;
            controller.enqueue(new TextEncoder().encode(delta));
          }
        }
        controller.close();
      },
    });

    const response = new StreamingTextResponse(stream);
    response.headers.set("X-Conversation-Id", convId);

    // Save assistant message
    (async () => {
      if (assistantContent) {
        if (messages.length <= 2) {
          const newTitle = assistantContent.substring(0, 60) || "New chat";
          await supabase.from("conversations").update({ title: newTitle }).eq("id", convId);
        }
        await supabase.from("messages").insert({
          conversation_id: convId,
          role: "assistant",
          content: assistantContent,
        });
      }
    })();

    return response;
  } catch (error: any) {
    console.error("OpenRouter streaming error:", error);
    return new Response(`AI Error: ${error.message}`, { status: 500 });
  }
}
