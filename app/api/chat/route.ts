import { StreamingTextResponse } from "ai";
import OpenAI from "openai";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";

// Candidate free Groq models – we'll try them in order
const MODEL_CANDIDATES = [
  "llama3-8b-8192",           // older naming, widely available
  "llama3-70b-8192",          // larger, still free
  "mixtral-8x7b-32768",       // Mixtral
  "gemma-7b-it",              // Google Gemma
  "llama-3.1-8b-instant",     // in case it's re-enabled
];

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

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { messages, conversationId } = await req.json();

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

  const systemPrompt = `You are Digolos D.K.K, a helpful, witty, and knowledgeable AI assistant. You provide clear answers, use a friendly tone, and occasionally sign off with "Stay curious! – D.K.K".`;

  const fullMessages = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];

  // Try each model until one works
  let completion: any = null;
  let usedModel = "";
  for (const model of MODEL_CANDIDATES) {
    try {
      completion = await openai.chat.completions.create({
        model,
        stream: true,
        messages: fullMessages as any,
      });
      usedModel = model;
      break; // success – stop trying
    } catch (err: any) {
      // If it's a model_not_found error, try next model; otherwise rethrow
      if (err?.code === "model_not_found" || err?.status === 404) {
        console.warn(`Model ${model} not available, trying next...`);
        continue;
      } else {
        console.error("Groq API error:", err);
        return new Response(`AI Error: ${err.message}`, { status: 500 });
      }
    }
  }

  if (!completion) {
    return new Response("No available Groq model found. Check your API key and account.", { status: 500 });
  }

  try {
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
    console.error("Groq streaming error:", error);
    return new Response(`AI Error: ${error.message}`, { status: 500 });
  }
}
