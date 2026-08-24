import { StreamingTextResponse } from "ai";
import OpenAI from "openai";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Response("OpenAI API key is not configured", { status: 500 });
  }

  const openai = new OpenAI({
    apiKey,
    baseURL: "https://api.groq.com/openai/v1",
  });

  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  // Authenticate user
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { messages, conversationId } = await req.json();

  // Create a conversation if none is provided
  let convId = conversationId;
  if (!convId) {
    const { data: conv, error: convError } = await supabase
      .from("conversations")
      .insert({
        user_id: user.id,
        title: messages[0]?.content?.substring(0, 100) || "New chat",
      })
      .select("id")
      .single();

    if (convError) {
      console.error("Conversation creation error:", convError);
      return new Response("Failed to create conversation", { status: 500 });
    }
    convId = conv.id;
  }

  // Save the last user message
  const lastUserMessage = messages[messages.length - 1];
  if (lastUserMessage.role === "user") {
    const { error: msgError } = await supabase.from("messages").insert({
      conversation_id: convId,
      role: "user",
      content: lastUserMessage.content,
    });
    if (msgError) {
      console.error("Message insert error:", msgError);
    }
  }

  // System prompt
  const systemPrompt = `You are Digolos D.K.K, a helpful, witty, and knowledgeable AI assistant. You provide clear answers, use a friendly tone, and occasionally sign off with "Stay curious! – D.K.K".`;

  const fullMessages = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];

  // Dynamically retrieve available models from Groq
  let availableModels: string[] = [];
  try {
    const modelsResponse = await openai.models.list();
    availableModels = modelsResponse.data.map((m: any) => m.id);
  } catch (err: any) {
    console.error("Failed to list models:", err);
    // If we can't list models, fall back to a small set of possible new names
    availableModels = [
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "mixtral-8x7b-32768",
      "gemma2-9b-it",
    ];
  }

  // Filter to chat-capable models (best guess: exclude audio/embedding models)
  const chatModels = availableModels.filter(
    (id) =>
      id.includes("llama") ||
      id.includes("mixtral") ||
      id.includes("gemma") ||
      id.includes("deepseek")
  );

  if (chatModels.length === 0) {
    return new Response("No chat models available on Groq. Check your API key or account.", { status: 500 });
  }

  // Prefer a 70B model if present, else first available
  let selectedModel =
    chatModels.find((m) => m.includes("70b")) ||
    chatModels.find((m) => m.includes("llama-3.3")) ||
    chatModels[0];

  try {
    const completion = await openai.chat.completions.create({
      model: selectedModel,
      stream: true,
      messages: fullMessages as any,
    });

    let assistantContent = "";
    const stream = new ReadableStream({
      async start(controller) {
        for await (const chunk of completion) {
          const content = chunk.choices[0]?.delta?.content;
          if (content) {
            assistantContent += content;
            controller.enqueue(new TextEncoder().encode(content));
          }
        }
        controller.close();
      },
    });

    const response = new StreamingTextResponse(stream);
    response.headers.set("X-Conversation-Id", convId);

    // Save assistant message after streaming
    (async () => {
      if (assistantContent) {
        try {
          if (messages.length <= 2) {
            const newTitle = assistantContent.substring(0, 60) || "New chat";
            await supabase
              .from("conversations")
              .update({ title: newTitle })
              .eq("id", convId);
          }
          await supabase.from("messages").insert({
            conversation_id: convId,
            role: "assistant",
            content: assistantContent,
          });
        } catch (err) {
          console.error("Failed to save assistant message:", err);
        }
      }
    })();

    return response;
  } catch (error: any) {
    console.error("Groq API error:", error);
    return new Response(`AI Error: ${error.message}`, { status: 500 });
  }
}
