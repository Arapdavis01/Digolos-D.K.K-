import { StreamingTextResponse } from "ai";
import OpenAI from "openai";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";

export async function POST(req: Request) {
  // Create the client dynamically so the build doesn't fail if the env var is missing
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

  try {
    const completion = await openai.chat.completions.create({
      model: "llama-3.1-8b-instant",
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
