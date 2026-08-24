import { StreamingTextResponse } from "ai";
import OpenAI from "openai";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";

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

  // Use OpenRouter's stable free model
  const model = "meta-llama/llama-3.1-8b-instruct:free";

  try {
    const completion = await openai.chat.completions.create({
      model,
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
    console.error("OpenRouter error:", error);
    return new Response(`AI Error: ${error.message}`, { status: 500 });
  }
}
