import { OpenAIStream, StreamingTextResponse } from "ai";
import OpenAI from "openai";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(req: Request) {
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
      return new Response("Failed to create conversation", { status: 500 });
    }
    convId = conv.id;
  }

  // Save the last user message (the one just sent)
  const lastUserMessage = messages[messages.length - 1];
  if (lastUserMessage.role === "user") {
    await supabase.from("messages").insert({
      conversation_id: convId,
      role: "user",
      content: lastUserMessage.content,
    });
  }

  // System prompt defines the agent's identity
  const systemPrompt = `You are Digolos D.K.K, a helpful, witty, and knowledgeable AI assistant. You provide clear answers, use a friendly tone, and occasionally sign off with "Stay curious! – D.K.K".`;

  const fullMessages = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];

  // Call OpenAI with streaming
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    stream: true,
    messages: fullMessages as any,
  });

  // Stream response and save assistant message on completion
  const stream = OpenAIStream(response, {
    async onCompletion(completion) {
      // Update conversation title with first message if it's a new conversation
      if (messages.length <= 2) {
        const newTitle = completion.substring(0, 60) || "New chat";
        await supabase
          .from("conversations")
          .update({ title: newTitle })
          .eq("id", convId);
      }

      await supabase.from("messages").insert({
        conversation_id: convId,
        role: "assistant",
        content: completion,
      });
    },
  });

  return new StreamingTextResponse(stream, {
    headers: {
      "X-Conversation-Id": convId,
    },
  });
}
